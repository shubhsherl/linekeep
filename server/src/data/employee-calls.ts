import { z } from "zod";

import { callType, callHistoryCursor, type CallHistoryCursor, type CallHistoryItem } from "./call-history";
import { callPhoneKey } from "./customers";
import { utcTimestamp } from "./values";

const listInput = z.strictObject({
  callType: callType.optional(),
  number: z.string().max(256).optional(),
  /** Last ten digits of the number, as `callPhoneKey` computes them; exact match instead of `number`'s substring match. */
  phoneKey: z.string().regex(/^\d{10}$/).optional(),
  from: utcTimestamp.optional(),
  to: utcTimestamp.optional(),
  hasRecording: z.boolean().optional(),
  cursor: callHistoryCursor.optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).refine((value) => !value.from || !value.to || value.from <= value.to);

/** A call as an employee sees it: recording presence only, never recording ids or any way to fetch audio. */
export type EmployeeCallItem = Omit<CallHistoryItem, "recordings"> & {
  hasRecording: boolean;
  /** Only ever one of the caller's own customers. */
  customer?: { id: string; name: string };
};

type Row = {
  id: string; device_id: string; employee_id: string; employee_name: string; started_at: string;
  duration_seconds: number; call_type: CallHistoryItem["callType"]; remote_number: string | null;
  caller_name: string | null; local_number: string | null; sim_label: string | null;
  phone_account_id: string | null; created_at: string; has_recording: number;
};

// Completed, undeleted audio linked to a call: the same definition as the administrator feed and analytics.
const completedLink = `x.call_log_id IS NOT NULL AND x.upload_status = 'complete' AND x.deleted_at IS NULL`;

/** Read-only call history of one employee. Every query is bound to that employee's id in SQL. */
export function createEmployeeCallRepository(db: D1Database) {
  return {
    /** The employee's own completed recording of one call-log entry, or null (unknown call, someone else's, none, deleted). */
    async recordingFor(employeeId: string, callLogId: string): Promise<{ objectKey: string; contentType: string; displayName: string } | null> {
      const row = await db.prepare(
        `SELECT x.object_key, x.content_type, x.display_name FROM calls x
        JOIN call_logs h ON h.id = x.call_log_id
        WHERE x.call_log_id = ? AND h.employee_id = ? AND x.employee_id = ? AND h.deleted_at IS NULL AND ${completedLink}
        ORDER BY x.created_at DESC, x.id DESC LIMIT 1`,
      ).bind(callLogId, employeeId, employeeId).first<{ object_key: string; content_type: string; display_name: string }>();
      return row ? { objectKey: row.object_key, contentType: row.content_type, displayName: row.display_name } : null;
    },

    async list(employeeId: string, input: z.input<typeof listInput> = {}): Promise<{
      items: EmployeeCallItem[];
      nextCursor: CallHistoryCursor | null;
    }> {
      const value = listInput.parse(input);
      const conditions = ["h.employee_id = ?", "h.deleted_at IS NULL"];
      const bindings: (string | number)[] = [employeeId];
      if (value.phoneKey !== undefined) { conditions.push("h.phone_key = ?"); bindings.push(value.phoneKey); }
      if (value.number !== undefined) {
        conditions.push("h.remote_number LIKE ? ESCAPE '\\'");
        bindings.push(`%${value.number.replace(/[\\%_]/g, "\\$&")}%`);
      }
      if (value.callType !== undefined) { conditions.push("h.call_type = ?"); bindings.push(value.callType); }
      if (value.from !== undefined) { conditions.push("h.started_at >= ?"); bindings.push(value.from); }
      if (value.to !== undefined) { conditions.push("h.started_at <= ?"); bindings.push(value.to); }
      if (value.cursor) { conditions.push("(h.started_at, h.id) < (?, ?)"); bindings.push(value.cursor.sortAt, value.cursor.id); }
      if (value.hasRecording) {
        conditions.push(`h.id IN (SELECT x.call_log_id FROM calls x INDEXED BY calls_linked_idx WHERE ${completedLink})`);
      }
      // The page is cut inside the subquery, so the per-row recording probe runs for `limit` rows only.
      const rows = await db.prepare(`
        SELECT h.id, h.device_id, h.employee_id, e.name AS employee_name, h.started_at, h.duration_seconds,
          h.call_type, h.remote_number, h.caller_name, h.local_number, h.sim_label, h.phone_account_id, h.created_at,
          EXISTS (SELECT 1 FROM calls x INDEXED BY calls_linked_idx WHERE x.call_log_id = h.id AND ${completedLink}) AS has_recording
        FROM (SELECT * FROM call_logs h WHERE ${conditions.join(" AND ")}
          ORDER BY h.started_at DESC, h.id DESC LIMIT ?) h
        JOIN employees e ON e.id = h.employee_id
        ORDER BY h.started_at DESC, h.id DESC`).bind(...bindings, value.limit + 1).all<Row>();

      const hasMore = rows.results.length > value.limit;
      const page = hasMore ? rows.results.slice(0, value.limit) : rows.results;
      const customers = await ownCustomersByPhoneKey(
        db, employeeId, page.map((row) => callPhoneKey(row.remote_number ?? undefined)),
      );
      const items = page.map((row): EmployeeCallItem => {
        const key = callPhoneKey(row.remote_number ?? undefined);
        const customer = key ? customers.get(key) : undefined;
        return {
          kind: "call", id: row.id, deviceId: row.device_id,
          employee: { id: row.employee_id, name: row.employee_name },
          startedAt: row.started_at, durationSeconds: row.duration_seconds, callType: row.call_type,
          remoteNumber: row.remote_number ?? undefined, callerName: row.caller_name ?? undefined,
          localNumber: row.local_number ?? undefined, simLabel: row.sim_label ?? undefined,
          phoneAccountId: row.phone_account_id ?? undefined,
          hasRecording: row.has_recording === 1, createdAt: row.created_at,
          ...(customer ? { customer } : {}),
        };
      });
      const last = items.at(-1);
      return { items, nextCursor: hasMore && last ? { sortAt: last.startedAt, id: last.id } : null };
    },
  };
}

/** Live customers assigned to this employee, keyed by `phone_key`; other employees' customers are not matched. */
async function ownCustomersByPhoneKey(
  db: D1Database, employeeId: string, keys: (string | null)[],
): Promise<Map<string, { id: string; name: string }>> {
  const unique = [...new Set(keys.filter((key): key is string => key !== null && /^\d{8,10}$/.test(key)))].slice(0, 90);
  const result = new Map<string, { id: string; name: string }>();
  if (unique.length === 0) return result;
  const rows = await db.prepare(
    `SELECT c.id, c.name, c.phone_key FROM customers c WHERE c.archived_at IS NULL
      AND c.phone_key IN (${unique.map(() => "?").join(",")})
      AND EXISTS (SELECT 1 FROM customer_employees s WHERE s.customer_id = c.id AND s.employee_id = ?)`,
  ).bind(...unique, employeeId).all<{ id: string; name: string; phone_key: string }>();
  for (const row of rows.results) result.set(row.phone_key, { id: row.id, name: row.name });
  return result;
}
