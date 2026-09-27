import { z } from "zod";

import {
  type Clock,
  id,
  nonnegativeInteger,
  opaqueId,
  positiveInteger,
  timestamp,
  utcTimestamp,
} from "./values";

const direction = z.enum(["incoming", "outgoing", "unknown"]);
const matchStatus = z.enum([
  "filename",
  "media_metadata",
  "call_log",
  "unmatched",
]);
const uploadStatus = z.enum(["pending", "complete", "failed", "deleted"]);
const pendingInput = z.object({
  deviceId: id,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  displayName: z.string().min(1),
  contentType: z.string().min(1),
  expectedBytes: positiveInteger,
  recordedAt: utcTimestamp.optional(),
  durationSeconds: nonnegativeInteger.optional(),
  remoteNumber: z.string().optional(),
  direction: direction.optional(),
  matchStatus,
});
const cursorInput = z.object({ sortAt: utcTimestamp, id });
const listInput = z.object({
  employeeId: id.optional(),
  direction: direction.optional(),
  number: z.string().optional(),
  from: utcTimestamp.optional(),
  to: utcTimestamp.optional(),
  status: uploadStatus.optional(),
  cursor: cursorInput.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export interface CallRecord {
  id: string;
  employeeId: string;
  deviceId: string;
  fingerprint: string;
  displayName: string;
  remoteNumber?: string;
  direction?: z.infer<typeof direction>;
  recordedAt?: string;
  durationSeconds?: number;
  matchStatus: z.infer<typeof matchStatus>;
  objectKey: string;
  contentType: string;
  expectedBytes: number;
  actualBytes?: number;
  objectEtag?: string;
  uploadStatus: z.infer<typeof uploadStatus>;
  uploadedAt?: string;
  createdAt: string;
  deletedAt?: string;
}

export type CallCursor = z.infer<typeof cursorInput>;
export type CallListItem = CallRecord & {
  employee: { id: string; name: string };
};

export function adminCallDto(call: CallListItem): AdminCall {
  return {
    id: call.id,
    employee: { id: call.employee.id, name: call.employee.name },
    deviceId: call.deviceId,
    displayName: call.displayName,
    remoteNumber: call.remoteNumber,
    direction: call.direction,
    recordedAt: call.recordedAt,
    durationSeconds: call.durationSeconds,
    matchStatus: call.matchStatus,
    uploadStatus: call.uploadStatus,
    actualBytes: call.actualBytes,
    uploadedAt: call.uploadedAt,
  };
}
export type AdminCall = Pick<CallListItem,
  "id" | "employee" | "deviceId" | "displayName" | "remoteNumber" |
  "direction" | "recordedAt" | "durationSeconds" | "matchStatus" |
  "uploadStatus" | "actualBytes" | "uploadedAt">;

export class InvalidCallStateError extends Error {
  constructor() {
    super("Call cannot make the requested state transition");
    this.name = "InvalidCallStateError";
  }
}

export type CallRow = {
  id: string;
  employee_id: string;
  device_id: string;
  fingerprint: string;
  display_name: string;
  remote_number: string | null;
  direction: CallRecord["direction"] | null;
  recorded_at: string | null;
  duration_seconds: number | null;
  match_status: CallRecord["matchStatus"];
  object_key: string;
  content_type: string;
  expected_bytes: number;
  actual_bytes: number | null;
  object_etag: string | null;
  upload_status: CallRecord["uploadStatus"];
  uploaded_at: string | null;
  created_at: string;
  deleted_at: string | null;
};

export function call(row: CallRow): CallRecord {
  return {
    id: row.id,
    employeeId: row.employee_id,
    deviceId: row.device_id,
    fingerprint: row.fingerprint,
    displayName: row.display_name,
    remoteNumber: row.remote_number ?? undefined,
    direction: row.direction ?? undefined,
    recordedAt: row.recorded_at ?? undefined,
    durationSeconds: row.duration_seconds ?? undefined,
    matchStatus: row.match_status,
    objectKey: row.object_key,
    contentType: row.content_type,
    expectedBytes: row.expected_bytes,
    actualBytes: row.actual_bytes ?? undefined,
    objectEtag: row.object_etag ?? undefined,
    uploadStatus: row.upload_status,
    uploadedAt: row.uploaded_at ?? undefined,
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}

/** R2 verification belongs to the upload module; this boundary enforces persistent state/ownership. */
export function createCallRepository(
  db: D1Database,
  clock: Clock = () => new Date(),
) {
  async function getById(callId: string): Promise<CallRecord | null> {
    const row = await db
      .prepare("SELECT * FROM calls WHERE id = ?")
      .bind(id.parse(callId))
      .first<CallRow>();
    return row ? call(row) : null;
  }

  async function getForDevice(
    callId: string,
    deviceId: string,
  ): Promise<CallRecord | null> {
    const row = await db
      .prepare("SELECT * FROM calls WHERE id = ? AND device_id = ?")
      .bind(id.parse(callId), id.parse(deviceId))
      .first<CallRow>();
    return row ? call(row) : null;
  }

  async function isActiveOwner(callId: string): Promise<boolean> {
    const row = await db
      .prepare(
        `SELECT 1 AS active FROM calls c
      JOIN devices d ON d.id = c.device_id
      JOIN employees current ON current.id = d.employee_id
      JOIN employees historical ON historical.id = c.employee_id
      WHERE c.id = ? AND d.revoked_at IS NULL AND current.active = 1 AND historical.active = 1`,
      )
      .bind(id.parse(callId))
      .first();
    return row !== null;
  }

  return {
    getById,
    getForDevice,
    isActiveOwner,

    async createPending(
      input: z.input<typeof pendingInput>,
    ): Promise<CallRecord | null> {
      const value = pendingInput.parse(input);
      const now = timestamp(clock);
      const callId = opaqueId("call");
      const row = await db
        .prepare(
          `INSERT INTO calls
        (id, employee_id, device_id, fingerprint, display_name, remote_number, direction, recorded_at,
         duration_seconds, match_status, object_key, content_type, expected_bytes, upload_status, created_at)
        SELECT ?, assignment.employee_id, d.id, ?, ?, ?, ?, ?, ?, ?,
          'recordings/' || assignment.employee_id || '/' || ? || '/' || ?, ?, ?, 'pending', ?
        FROM devices d JOIN employees e ON e.id = d.employee_id
        JOIN device_assignments assignment ON assignment.device_id = d.id
          AND assignment.assigned_at = (
            SELECT assigned_at FROM device_assignments
            WHERE device_id = d.id AND (assigned_at <= ? OR is_initial = 1)
            ORDER BY assigned_at DESC LIMIT 1)
        JOIN employees historical ON historical.id = assignment.employee_id
        WHERE d.id = ? AND d.revoked_at IS NULL AND e.active = 1 AND historical.active = 1
          AND (? IS NOT NULL OR NOT EXISTS (
            SELECT 1 FROM device_assignments WHERE device_id = d.id AND is_initial = 0))
        ON CONFLICT(device_id, fingerprint) DO NOTHING RETURNING *`,
        )
        .bind(
          callId,
          value.fingerprint,
          value.displayName,
          value.remoteNumber ?? null,
          value.direction ?? null,
          value.recordedAt ?? null,
          value.durationSeconds ?? null,
          value.matchStatus,
          `${now.slice(0, 4)}/${now.slice(5, 7)}`,
          callId,
          value.contentType,
          value.expectedBytes,
          now,
          value.recordedAt ?? now,
          value.deviceId,
          value.recordedAt ?? null,
        )
        .first<CallRow>();
      if (row) return call(row);
      // A replay must not change metadata, ownership, object key, or an existing terminal state.
      const existing = await db
        .prepare(
          `SELECT * FROM calls WHERE device_id = ? AND fingerprint = ?
        AND EXISTS (SELECT 1 FROM devices d JOIN employees e ON e.id = d.employee_id
          WHERE d.id = calls.device_id AND d.revoked_at IS NULL AND e.active = 1)
        AND EXISTS (SELECT 1 FROM employees WHERE id = calls.employee_id AND active = 1)`,
        )
        .bind(value.deviceId, value.fingerprint)
        .first<CallRow>();
      if (existing) return call(existing);
      // Replays take precedence over missing-timestamp ambiguity, even after a handover.
      if (value.recordedAt === undefined) {
        const ambiguous = await db
          .prepare(
            `SELECT 1 FROM devices d
          JOIN employees e ON e.id = d.employee_id
          WHERE d.id = ? AND d.revoked_at IS NULL AND e.active = 1
          AND EXISTS (SELECT 1 FROM device_assignments WHERE device_id = d.id AND is_initial = 0)`,
          )
          .bind(value.deviceId)
          .first();
        if (ambiguous) throw new InvalidCallStateError();
      }
      return null;
    },

    async complete(
      callId: string,
      deviceId: string,
      input: { actualBytes: number; etag?: string },
    ): Promise<CallRecord | null> {
      const value = z
        .object({ actualBytes: positiveInteger, etag: z.string().optional() })
        .parse(input);
      const row = await db
        .prepare(
          `UPDATE calls SET upload_status = 'complete', actual_bytes = ?,
        object_etag = ?, uploaded_at = ? WHERE id = ? AND device_id = ?
        AND upload_status = 'pending' AND expected_bytes = ?
        AND EXISTS (SELECT 1 FROM devices d JOIN employees e ON e.id = d.employee_id
          JOIN employees historical ON historical.id = calls.employee_id
          WHERE d.id = calls.device_id
          AND d.revoked_at IS NULL AND e.active = 1 AND historical.active = 1) RETURNING *`,
        )
        .bind(
          value.actualBytes,
          value.etag ?? null,
          timestamp(clock),
          id.parse(callId),
          id.parse(deviceId),
          value.actualBytes,
        )
        .first<CallRow>();
      if (row) return call(row);
      const existing = await getForDevice(callId, deviceId);
      if (existing && existing.uploadStatus !== "complete")
        throw new InvalidCallStateError();
      return existing;
    },

    async markFailed(
      callId: string,
      deviceId: string,
    ): Promise<CallRecord | null> {
      const row = await db
        .prepare(
          `UPDATE calls SET upload_status = 'failed'
        WHERE id = ? AND device_id = ? AND upload_status IN ('pending', 'failed') RETURNING *`,
        )
        .bind(id.parse(callId), id.parse(deviceId))
        .first<CallRow>();
      if (row) return call(row);
      if (await getForDevice(callId, deviceId))
        throw new InvalidCallStateError();
      return null;
    },

    async retryFailed(
      callId: string,
      deviceId: string,
    ): Promise<CallRecord | null> {
      const row = await db
        .prepare(
          `UPDATE calls SET upload_status = 'pending'
        WHERE id = ? AND device_id = ? AND upload_status IN ('failed', 'pending') RETURNING *`,
        )
        .bind(id.parse(callId), id.parse(deviceId))
        .first<CallRow>();
      if (row) return call(row);
      if (await getForDevice(callId, deviceId))
        throw new InvalidCallStateError();
      return null;
    },

    /** Call only after R2 deletion succeeds (including an already-missing object). */
    async markDeleted(callId: string): Promise<CallRecord | null> {
      const row = await db
        .prepare(
          `UPDATE calls SET upload_status = 'deleted', deleted_at = COALESCE(deleted_at, ?)
        WHERE id = ? RETURNING *`,
        )
        .bind(timestamp(clock), id.parse(callId))
        .first<CallRow>();
      return row ? call(row) : null;
    },

    /** Sort/filter by recordedAt, falling back to receipt time when source metadata is absent. */
    async list(
      input: z.input<typeof listInput> = {},
    ): Promise<{ items: CallListItem[]; nextCursor: CallCursor | null }> {
      const value = listInput.parse(input);
      if (value.from && value.to && value.from > value.to)
        throw new RangeError("from must not exceed to");
      const conditions: string[] = [];
      const bindings: (string | number)[] = [];
      if (value.employeeId !== undefined) {
        conditions.push("c.employee_id = ?");
        bindings.push(value.employeeId);
      }
      if (value.direction !== undefined) {
        conditions.push("c.direction = ?");
        bindings.push(value.direction);
      }
      if (value.status !== undefined) {
        conditions.push("c.upload_status = ?");
        bindings.push(value.status);
      }
      if (value.number !== undefined) {
        conditions.push("c.remote_number LIKE ? ESCAPE '\\'");
        bindings.push(`%${value.number.replace(/[\\%_]/g, "\\$&")}%`);
      }
      if (value.from !== undefined) {
        conditions.push("COALESCE(c.recorded_at, c.created_at) >= ?");
        bindings.push(value.from);
      }
      if (value.to !== undefined) {
        conditions.push("COALESCE(c.recorded_at, c.created_at) <= ?");
        bindings.push(value.to);
      }
      if (value.cursor) {
        conditions.push(
          "(COALESCE(c.recorded_at, c.created_at), c.id) < (?, ?)",
        );
        bindings.push(value.cursor.sortAt, value.cursor.id);
      }
      const rows = await db
        .prepare(
          `SELECT c.*, e.name AS employee_name FROM calls c
        JOIN employees e ON e.id = c.employee_id ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY COALESCE(c.recorded_at, c.created_at) DESC, c.id DESC LIMIT ?`,
        )
        .bind(...bindings, value.limit + 1)
        .all<CallRow & { employee_name: string }>();
      const hasMore = rows.results.length > value.limit;
      if (hasMore) rows.results.pop();
      const last = rows.results.at(-1);
      return {
        items: rows.results.map((row) => ({
          ...call(row),
          employee: { id: row.employee_id, name: row.employee_name },
        })),
        nextCursor:
          hasMore && last
            ? { sortAt: last.recorded_at ?? last.created_at, id: last.id }
            : null,
      };
    },
  };
}
