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

type CallFeedRow = {
  id: string; device_id: string; employee_id: string; employee_name: string; started_at: string; sort_at: string;
  duration_seconds: number; call_type: CallHistoryItem["callType"]; remote_number: string | null;
  caller_name: string | null; local_number: string | null; sim_label: string | null;
  phone_account_id: string | null; created_at: string;
};
type RecordingFeedRow = CallRow & { employee_name: string; sort_at: string };

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
        -- A replay that changes nothing must be free: skipping the UPDATE avoids rewriting the row and its indexes and
        -- re-running association. Each disjunct mirrors exactly what the SET clause above can change.
        WHERE call_logs.deleted_at IS NULL AND (
          call_logs.duration_seconds IS NOT excluded.duration_seconds
          OR call_logs.call_type IS NOT excluded.call_type
          OR call_logs.remote_number IS NOT excluded.remote_number
          OR (excluded.caller_name IS NOT NULL AND call_logs.caller_name IS NOT excluded.caller_name)
          OR (call_logs.local_number IS NULL AND excluded.local_number IS NOT NULL)
          OR (call_logs.sim_label IS NULL AND excluded.sim_label IS NOT NULL)
          OR (call_logs.phone_account_id IS NULL AND excluded.phone_account_id IS NOT NULL)
        )`,
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
      const like = value.number === undefined ? undefined : `%${value.number.replace(/[\\%_]/g, "\\$&")}%`;
      // The page is ordered by (sort_at, id) over two sources: call history and audio that no call claims. Each
      // source is read from its own index with the limit pushed down, so a page costs about `limit` rows rather
      // than the whole history; the two short lists are then merged. Associations include tombstone evidence
      // independently of these live filters, and attachments never consume page slots.
      const bounded = (sortExpr: string, alias: string, base: string) => {
        const conditions = [base];
        const bindings: (string | number)[] = [];
        if (value.employeeId !== undefined) { conditions.push(`${alias}.employee_id = ?`); bindings.push(value.employeeId); }
        if (like !== undefined) { conditions.push(`${alias}.remote_number LIKE ? ESCAPE '\\'`); bindings.push(like); }
        if (value.from !== undefined) { conditions.push(`${sortExpr} >= ?`); bindings.push(value.from); }
        if (value.to !== undefined) { conditions.push(`${sortExpr} <= ?`); bindings.push(value.to); }
        if (value.cursor) { conditions.push(`(${sortExpr}, ${alias}.id) < (?, ?)`); bindings.push(value.cursor.sortAt, value.cursor.id); }
        return { conditions, bindings };
      };
      const callPart = bounded("h.started_at", "h", "h.deleted_at IS NULL");
      if (value.callType !== undefined) { callPart.conditions.push("h.call_type = ?"); callPart.bindings.push(value.callType); }
      if (value.hasRecording) {
        // Started from the small set of linked, completed recordings (calls_linked_idx), not by probing every call.
        callPart.conditions.push(`h.id IN (SELECT x.call_log_id FROM calls x INDEXED BY calls_linked_idx
          WHERE x.call_log_id IS NOT NULL AND x.upload_status = 'complete' AND x.deleted_at IS NULL)`);
      }
      const recPart = bounded("COALESCE(r.recorded_at, r.created_at)", "r", "r.call_log_id IS NULL AND r.upload_status <> 'deleted'");
      if (value.hasRecording) recPart.conditions.push("r.upload_status = 'complete'");
      const limit = value.limit + 1;
      const statements = [db.prepare(`
        SELECT h.id, h.device_id, h.employee_id, e.name AS employee_name, h.started_at, h.started_at AS sort_at,
          h.duration_seconds, h.call_type, h.remote_number, h.caller_name, h.local_number, h.sim_label,
          h.phone_account_id, h.created_at
        FROM (SELECT * FROM call_logs h WHERE ${callPart.conditions.join(" AND ")}
          ORDER BY h.started_at DESC, h.id DESC LIMIT ?) h
        JOIN employees e ON e.id = h.employee_id
        ORDER BY h.started_at DESC, h.id DESC`).bind(...callPart.bindings, limit)];
      // Unlinked audio has no call type, so a call-type filter excludes it entirely. The ordered partial index is pinned:
      // left to its statistics SQLite may pick the call_log_id index and sort every unlinked recording.
      if (value.callType === undefined) {
        statements.push(db.prepare(`
          SELECT r.*, e.name AS employee_name, COALESCE(r.recorded_at, r.created_at) AS sort_at
          FROM (SELECT * FROM calls r INDEXED BY calls_unlinked_directory_idx WHERE ${recPart.conditions.join(" AND ")}
            ORDER BY COALESCE(r.recorded_at, r.created_at) DESC, r.id DESC LIMIT ?) r
          JOIN employees e ON e.id = r.employee_id
          ORDER BY sort_at DESC, r.id DESC`).bind(...recPart.bindings, limit));
      }
      const [callResult, recordingResult] = statements.length === 1
        ? [await statements[0].all<CallFeedRow>(), undefined]
        : await db.batch<CallFeedRow | RecordingFeedRow>(statements);
      const merged = [
        ...(callResult.results as CallFeedRow[]).map((row) => ({ kind: "call" as const, row })),
        ...((recordingResult?.results ?? []) as RecordingFeedRow[]).map((row) => ({ kind: "recording" as const, row })),
      ].sort((a, b) => (a.row.sort_at === b.row.sort_at
        ? (a.row.id < b.row.id ? 1 : -1)
        : (a.row.sort_at < b.row.sort_at ? 1 : -1))).slice(0, limit);

      // Audio attached to the page's calls (never deleted audio), newest first. IN lists stay under D1's
      // 100-parameter limit; the call_log_id index is pinned because unlinked audio skews its statistics.
      const callIds = merged.filter((entry) => entry.kind === "call").map((entry) => entry.row.id);
      const attached = new Map<string, CallRow[]>();
      const chunks: string[][] = [];
      for (let i = 0; i < callIds.length; i += 90) chunks.push(callIds.slice(i, i + 90));
      if (chunks.length) {
        const results = await db.batch<CallRow>(chunks.map((ids) => db.prepare(
          `SELECT r.* FROM calls r INDEXED BY calls_history_idx WHERE r.upload_status <> 'deleted' AND r.call_log_id IN (${ids.map(() => "?").join(",")})
           ORDER BY r.created_at DESC, r.id DESC`,
        ).bind(...ids)));
        for (const result of results) {
          for (const row of result.results) {
            const key = (row as CallRow & { call_log_id: string }).call_log_id;
            (attached.get(key) ?? attached.set(key, []).get(key)!).push(row);
          }
        }
      }
      const items: UnifiedCallItem[] = merged.map((entry): UnifiedCallItem => {
        if (entry.kind === "call") {
          const row = entry.row as CallFeedRow;
          const owner = { id: row.employee_id, name: row.employee_name };
          return {
            id: row.id, deviceId: row.device_id, employee: owner, createdAt: row.created_at,
            kind: "call", startedAt: row.started_at, durationSeconds: row.duration_seconds, callType: row.call_type,
            remoteNumber: row.remote_number ?? undefined, callerName: row.caller_name ?? undefined,
            localNumber: row.local_number ?? undefined, simLabel: row.sim_label ?? undefined,
            phoneAccountId: row.phone_account_id ?? undefined,
            recordings: (attached.get(row.id) ?? []).map((recording) => adminCallDto({ ...call(recording), employee: owner })),
          };
        }
        const row = entry.row as RecordingFeedRow;
        const owner = { id: row.employee_id, name: row.employee_name };
        return {
          id: row.id, deviceId: row.device_id, employee: owner, createdAt: row.created_at,
          kind: "recording", startedAt: row.recorded_at ?? undefined,
          recordings: [adminCallDto({ ...call(row), employee: owner })],
        };
      });
      const hasMore = items.length > value.limit;
      if (hasMore) items.pop();
      const last = items.at(-1);
      // Source-less audio uses creation time for ordering, not a fabricated start.
      return {
        items,
        nextCursor: hasMore && last ? { sortAt: last.startedAt ?? last.createdAt, id: last.id } : null,
      };
    },
  };
}
