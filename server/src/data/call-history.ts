import { z } from "zod";

import { adminCallDto, call, type AdminCall, type CallRow } from "./calls";
import { type Clock, opaqueId, timestamp, utcTimestamp } from "./values";

const boundedId = z.string().min(1).max(256);
export const callType = z.enum([
  "incoming", "outgoing", "missed", "rejected", "blocked", "voicemail",
  "answered_externally", "unknown",
]);
const entryInput = z.strictObject({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  startedAt: utcTimestamp,
  durationSeconds: z.number().int().min(0).max(604800),
  callType,
  remoteNumber: z.string().min(1).max(80).optional(),
  callerName: z.string().trim().min(1).max(256).optional(),
  localNumber: z.string().trim().min(1).max(80).optional(),
  simLabel: z.string().trim().min(1).max(120).optional(),
  phoneAccountId: z.string().trim().min(1).max(256).optional(),
});
export const callHistoryBatchInput = z.strictObject({
  deviceId: boundedId,
  entries: z.array(entryInput).min(1).max(50),
});
export const callHistoryCursor = z.strictObject({ sortAt: utcTimestamp, id: boundedId });
const listInput = z.strictObject({
  employeeId: boundedId.optional(),
  callType: callType.optional(),
  number: z.string().max(256).optional(),
  from: utcTimestamp.optional(),
  to: utcTimestamp.optional(),
  hasRecording: z.boolean().optional(),
  cursor: callHistoryCursor.optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).refine((value) => !value.from || !value.to || value.from <= value.to);

export type CallHistoryCursor = z.infer<typeof callHistoryCursor>;
export interface CallHistoryItem {
  kind: "call";
  id: string;
  deviceId: string;
  employee: { id: string; name: string };
  startedAt: string;
  durationSeconds: number;
  callType: z.infer<typeof callType>;
  remoteNumber?: string;
  callerName?: string;
  localNumber?: string;
  simLabel?: string;
  phoneAccountId?: string;
  recordings: AdminCall[];
  createdAt: string;
}
export interface UnlinkedRecordingItem {
  kind: "recording";
  id: string;
  deviceId: string;
  employee: { id: string; name: string };
  createdAt: string;
  startedAt?: string;
  recordings: AdminCall[];
}
export type UnifiedCallItem = CallHistoryItem | UnlinkedRecordingItem;
export class CallHistoryAuthorizationError extends Error {}
export class CallHistoryConflictError extends Error {}

type FeedRow = CallRow & {
  kind: UnifiedCallItem["kind"];
  feed_id: string;
  feed_device_id: string;
  feed_employee_id: string;
  employee_name: string;
  feed_started_at: string | null;
  feed_duration_seconds: number | null;
  call_type: CallHistoryItem["callType"] | null;
  feed_remote_number: string | null;
  caller_name: string | null;
  local_number: string | null;
  sim_label: string | null;
  phone_account_id: string | null;
  feed_created_at: string;
  sort_at: string;
};

export function createCallHistoryRepository(
  db: D1Database,
  clock: Clock = () => new Date(),
) {
  return {
    async upsertBatch(authenticatedDeviceId: string, input: z.input<typeof callHistoryBatchInput>) {
      const value = callHistoryBatchInput.parse(input);
      if (value.deviceId !== boundedId.parse(authenticatedDeviceId)) {
        throw new CallHistoryAuthorizationError();
      }
      const now = timestamp(clock);
      // Keep every input, including duplicates, in order so each receives its ID.
      // Assignment resolution and authorization happen within this transaction;
      // a guard failure on any entry rolls back all preceding writes.
      const statements = value.entries.map((entry) => db.prepare(
        `INSERT INTO call_logs
          (id, device_id, employee_id, fingerprint, started_at, duration_seconds, call_type, remote_number,
           caller_name, local_number, sim_label, phone_account_id, created_at)
        VALUES (?, ?, COALESCE(
          (SELECT employee_id FROM call_logs WHERE device_id = ? AND fingerprint = ?),
          (SELECT employee_id FROM device_assignments
            WHERE device_id = ? AND (assigned_at <= ? OR is_initial = 1)
            ORDER BY assigned_at DESC LIMIT 1)
        ), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id, fingerprint) DO UPDATE SET
          duration_seconds = excluded.duration_seconds,
          call_type = excluded.call_type,
          remote_number = excluded.remote_number,
          caller_name = COALESCE(excluded.caller_name, call_logs.caller_name),
          local_number = COALESCE(call_logs.local_number, excluded.local_number),
          sim_label = COALESCE(call_logs.sim_label, excluded.sim_label),
          phone_account_id = COALESCE(call_logs.phone_account_id, excluded.phone_account_id)
        WHERE call_logs.deleted_at IS NULL`,
      ).bind(
        opaqueId("call"), value.deviceId, value.deviceId, entry.fingerprint,
        value.deviceId, entry.startedAt, entry.fingerprint, entry.startedAt,
        entry.durationSeconds, entry.callType, entry.remoteNumber ?? null,
        entry.callerName ?? null, entry.localNumber ?? null, entry.simLabel ?? null,
        entry.phoneAccountId ?? null, now,
      ));
      // Read identities in the same transaction: tombstones intentionally skip
      // the upsert but still acknowledge every replay, including duplicate inputs.
      statements.push(db.prepare(
        `SELECT fingerprint, id FROM call_logs WHERE device_id = ?
          AND fingerprint IN (${value.entries.map(() => "?").join(", ")})`,
      ).bind(value.deviceId, ...value.entries.map((entry) => entry.fingerprint)));
      try {
        const results = await db.batch<{ fingerprint: string; id: string }>(statements);
        const identities = new Map(results.at(-1)!.results.map((row) => [row.fingerprint, row]));
        return value.entries.map((entry) => {
          const accepted = identities.get(entry.fingerprint);
          if (!accepted) throw new Error("Call history write returned no identity");
          return accepted;
        });
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("call_history_unauthorized")) {
            throw new CallHistoryAuthorizationError();
          }
          if (error.message.includes("call_history_identity_conflict")) {
            throw new CallHistoryConflictError();
          }
        }
        throw error;
      }
    },

    async markDeleted(id: string): Promise<void> {
      await db.prepare(
        "UPDATE call_logs SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
      ).bind(timestamp(clock), boundedId.parse(id)).run();
    },

    async list(input: z.input<typeof listInput> = {}): Promise<{
      items: UnifiedCallItem[];
      nextCursor: CallHistoryCursor | null;
    }> {
      const value = listInput.parse(input);
      const conditions: string[] = [];
      const bindings: (string | number)[] = [];
      if (value.employeeId !== undefined) {
        conditions.push("c.employee_id = ?");
        bindings.push(value.employeeId);
      }
      if (value.callType !== undefined) {
        conditions.push("c.call_type = ?");
        bindings.push(value.callType);
      }
      if (value.number !== undefined) {
        conditions.push("c.remote_number LIKE ? ESCAPE '\\'");
        bindings.push(`%${value.number.replace(/[\\%_]/g, "\\$&")}%`);
      }
      if (value.from !== undefined) {
        conditions.push("c.sort_at >= ?");
        bindings.push(value.from);
      }
      if (value.to !== undefined) {
        conditions.push("c.sort_at <= ?");
        bindings.push(value.to);
      }
      if (value.cursor) {
        conditions.push("(c.sort_at, c.id) < (?, ?)");
        bindings.push(value.cursor.sortAt, value.cursor.id);
      }
      if (value.hasRecording) conditions.push("c.has_recording = 1");
      // Associations include tombstone evidence, independently of these live filters.
      // Limit the union before joining audio, so attachments cannot consume page slots.
      const rows = await db.prepare(`
        WITH feed AS (
          SELECT 'call' AS kind, h.id, h.device_id, h.employee_id,
            h.started_at, h.started_at AS sort_at, h.duration_seconds, h.call_type,
            h.remote_number, h.caller_name, h.local_number, h.sim_label, h.phone_account_id, h.created_at,
            EXISTS (SELECT 1 FROM calls r WHERE r.call_log_id = h.id AND r.upload_status = 'complete') AS has_recording
          FROM call_logs h WHERE h.deleted_at IS NULL
          UNION ALL
          SELECT 'recording', r.id, r.device_id, r.employee_id,
            r.recorded_at, COALESCE(r.recorded_at, r.created_at), NULL, NULL,
            r.remote_number, NULL, NULL, NULL, NULL, r.created_at, r.upload_status = 'complete'
          FROM calls r WHERE r.call_log_id IS NULL AND r.upload_status <> 'deleted'
        ), page AS (
          SELECT c.* FROM feed c
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY c.sort_at DESC, c.id DESC LIMIT ?
        )
        SELECT r.*, p.kind, p.id AS feed_id, p.device_id AS feed_device_id,
          p.employee_id AS feed_employee_id, e.name AS employee_name,
          p.started_at AS feed_started_at, p.duration_seconds AS feed_duration_seconds,
          p.call_type, p.remote_number AS feed_remote_number, p.caller_name, p.local_number,
          p.sim_label, p.phone_account_id, p.created_at AS feed_created_at, p.sort_at
        FROM page p JOIN employees e ON e.id = p.employee_id
        LEFT JOIN calls r ON r.upload_status <> 'deleted' AND (
          (p.kind = 'call' AND r.call_log_id = p.id)
          OR (p.kind = 'recording' AND r.id = p.id))
        ORDER BY p.sort_at DESC, p.id DESC, r.created_at DESC, r.id DESC
      `).bind(...bindings, value.limit + 1).all<FeedRow>();
      const items: UnifiedCallItem[] = [];
      let lastSortAt = "";
      let lastKey = "";
      for (const row of rows.results) {
        const key = `${row.kind}:${row.feed_id}`;
        if (lastKey !== key) {
          lastKey = key;
          lastSortAt = row.sort_at;
          const common = {
            id: row.feed_id,
            deviceId: row.feed_device_id,
            employee: { id: row.feed_employee_id, name: row.employee_name },
            createdAt: row.feed_created_at,
            recordings: [] as AdminCall[],
          };
          items.push(row.kind === "call" ? {
            ...common, kind: "call", startedAt: row.feed_started_at!,
            durationSeconds: row.feed_duration_seconds!, callType: row.call_type!,
            remoteNumber: row.feed_remote_number ?? undefined,
            callerName: row.caller_name ?? undefined,
            localNumber: row.local_number ?? undefined,
            simLabel: row.sim_label ?? undefined,
            phoneAccountId: row.phone_account_id ?? undefined,
          } : { ...common, kind: "recording", startedAt: row.feed_started_at ?? undefined });
        }
        if (row.id) items.at(-1)!.recordings.push(adminCallDto({
          ...call(row), employee: { id: row.feed_employee_id, name: row.employee_name },
        }));
      }
      const hasMore = items.length > value.limit;
      if (hasMore) items.pop();
      const last = items.at(-1);
      // Source-less audio uses creation time for ordering, not a fabricated start.
      if (last) lastSortAt = last.startedAt ?? last.createdAt;
      return {
        items,
        nextCursor: hasMore && last ? { sortAt: lastSortAt, id: last.id } : null,
      };
    },
  };
}
