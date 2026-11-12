import { z } from "zod";

import { activityCategories, activityChannels } from "../activity/catalog";

const minute = 60 * 1000;
const day = 24 * 60 * minute;
// IST (Asia/Kolkata) has no daylight-saving transitions: a fixed +05:30 offset is exact (same as analytics).
const istOffset = 330 * minute;

export const ACTIVITY_PAGE_DEFAULT = 50;
export const ACTIVITY_PAGE_MAX = 200;
export const ACTIVITY_EXPORT_MAX = 5000;

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const flag = z.enum(["true", "false"]).transform((value) => value === "true");
const cursorText = z.string().min(1).max(512);

const filters = {
  /** An employee id, or `admin` (every administrator) or `system`. */
  employeeId: z.string().regex(/^(?:admin|system|[A-Za-z0-9_-]{1,128})$/).optional(),
  category: z.enum(activityCategories).optional(),
  action: z.string().regex(/^[a-z_]{1,60}$/).optional(),
  channel: z.enum(activityChannels).optional(),
  customerId: z.string().min(1).max(256).optional(),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  includeCustomerMessages: flag.optional(),
};

export const activityListQuery = z.strictObject({
  ...filters,
  cursor: cursorText.optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(ACTIVITY_PAGE_MAX)).optional(),
});
export const activityExportQuery = z.strictObject(filters);

export type ActivityFilters = z.infer<typeof activityExportQuery>;

export interface ActivityItem {
  id: string;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  category: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  channel: string;
  details: Record<string, unknown>;
  /** Present on sign-in (security) rows only. */
  ip?: string | null;
  userAgent?: string | null;
}

interface ActivityRow {
  id: string; occurred_at: string; actor_type: string; actor_id: string | null; actor_name: string | null;
  category: string; action: string; target_type: string | null; target_id: string | null; target_label: string | null;
  channel: string; details: string; ip: string | null; user_agent: string | null;
}

const selectRows = `SELECT id, occurred_at, actor_type, actor_id, actor_name, category, action, target_type, target_id,
  target_label, channel, details, ip, user_agent FROM activity_log`;

function item(row: ActivityRow): ActivityItem {
  let details: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.details);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed as Record<string, unknown>;
  } catch {
    details = {};
  }
  return {
    id: row.id, occurredAt: row.occurred_at, actorType: row.actor_type, actorId: row.actor_id, actorName: row.actor_name,
    category: row.category, action: row.action, targetType: row.target_type, targetId: row.target_id,
    targetLabel: row.target_label, channel: row.channel, details,
    ...(row.category === "signin" ? { ip: row.ip, userAgent: row.user_agent } : {}),
  };
}

/** Window [00:00 IST of `from`, 00:00 IST of the day after `to`) as UTC timestamps. */
function dayWindow(from: string | undefined, to: string | undefined) {
  return {
    start: from ? new Date(Date.parse(`${from}T00:00:00.000Z`) - istOffset).toISOString() : undefined,
    end: to ? new Date(Date.parse(`${to}T00:00:00.000Z`) + day - istOffset).toISOString() : undefined,
  };
}

const likeEscape = (text: string) => text.replace(/[\\%_]/g, (character) => `\\${character}`);

function where(filter: ActivityFilters, cursor?: { at: string; id: string }) {
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];
  if (filter.employeeId === "admin" || filter.employeeId === "system") {
    conditions.push("actor_type = ?");
    bindings.push(filter.employeeId);
  } else if (filter.employeeId) {
    // What the employee did, and what administrators did to the employee (an edit, signing them out).
    conditions.push("(actor_id = ? OR (target_type = 'employee' AND target_id = ?))");
    bindings.push(filter.employeeId, filter.employeeId);
  }
  if (filter.category) { conditions.push("category = ?"); bindings.push(filter.category); }
  if (filter.action) { conditions.push("action = ?"); bindings.push(filter.action); }
  if (filter.channel) { conditions.push("channel = ?"); bindings.push(filter.channel); }
  if (filter.customerId) { conditions.push("target_id = ?"); bindings.push(filter.customerId); }
  const { start, end } = dayWindow(filter.from, filter.to);
  if (start) { conditions.push("occurred_at >= ?"); bindings.push(start); }
  if (end) { conditions.push("occurred_at < ?"); bindings.push(end); }
  if (filter.q) {
    const pattern = `%${likeEscape(filter.q)}%`;
    conditions.push(`(actor_name LIKE ? ESCAPE '\\' OR target_label LIKE ? ESCAPE '\\' OR replace(action, '_', ' ') LIKE ? ESCAPE '\\')`);
    bindings.push(pattern, pattern, pattern);
  }
  if (filter.includeCustomerMessages !== true) conditions.push("actor_type <> 'customer'");
  if (cursor) {
    conditions.push("(occurred_at, id) < (?, ?)");
    bindings.push(cursor.at, cursor.id);
  }
  return { clause: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", bindings };
}

export interface ActivityCursor { at: string; id: string }

export function encodeActivityCursor(cursor: ActivityCursor): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(cursor))))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Null when the text is not a cursor this module issued. */
export function decodeActivityCursor(encoded: string): ActivityCursor | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    const bytes = Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0));
    const parsed = z.strictObject({ at: z.string().max(40), id: z.string().max(80) })
      .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    return encodeActivityCursor(parsed) === encoded ? parsed : null;
  } catch {
    return null;
  }
}

export function createActivityRepository(db: D1Database) {
  return {
    /** Newest first. */
    async list(filter: ActivityFilters, input: { cursor?: ActivityCursor; limit?: number } = {}): Promise<{ items: ActivityItem[]; nextCursor: ActivityCursor | null }> {
      const limit = input.limit ?? ACTIVITY_PAGE_DEFAULT;
      const { clause, bindings } = where(filter, input.cursor);
      const rows = await db.prepare(`${selectRows} ${clause} ORDER BY occurred_at DESC, id DESC LIMIT ?`)
        .bind(...bindings, limit + 1).all<ActivityRow>();
      const more = rows.results.length > limit;
      const page = more ? rows.results.slice(0, limit) : rows.results;
      const last = page.at(-1);
      return { items: page.map(item), nextCursor: more && last ? { at: last.occurred_at, id: last.id } : null };
    },

    async export(filter: ActivityFilters): Promise<{ items: ActivityItem[]; truncated: boolean }> {
      const { clause, bindings } = where(filter);
      const rows = await db.prepare(`${selectRows} ${clause} ORDER BY occurred_at DESC, id DESC LIMIT ?`)
        .bind(...bindings, ACTIVITY_EXPORT_MAX + 1).all<ActivityRow>();
      return { items: rows.results.slice(0, ACTIVITY_EXPORT_MAX).map(item), truncated: rows.results.length > ACTIVITY_EXPORT_MAX };
    },

    /** Deletes rows older than `days`; returns how many. */
    async purgeOlderThan(days: number, now: Date): Promise<number> {
      const cutoff = new Date(now.getTime() - days * day).toISOString();
      const result = await db.prepare("DELETE FROM activity_log WHERE occurred_at < ?").bind(cutoff).run();
      return result.meta.changes;
    },
  };
}

// ---- CSV ----

/** A cell that a spreadsheet would run as a formula is prefixed with an apostrophe; quotes are doubled. */
export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function detailsText(details: Record<string, unknown>): string {
  return Object.entries(details).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("|") : String(value)}`).join("; ");
}

export const CSV_HEADER = ["time_utc", "time_ist", "actor_type", "actor", "category", "action", "target_type", "target", "channel", "details", "ip", "browser"];

export function activityCsv(items: ActivityItem[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const entry of items) {
    const ist = new Date(Date.parse(entry.occurredAt) + istOffset).toISOString().slice(0, 19).replace("T", " ");
    lines.push([
      entry.occurredAt, ist, entry.actorType, entry.actorName ?? entry.actorId, entry.category, entry.action,
      entry.targetType, entry.targetLabel ?? entry.targetId, entry.channel, detailsText(entry.details),
      // The address and browser belong to sign-in (security) events only.
      entry.category === "signin" ? entry.ip : "", entry.category === "signin" ? entry.userAgent : "",
    ].map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
