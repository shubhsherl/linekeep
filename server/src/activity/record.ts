import type { Context } from "hono";

import type { ActivityActorType, ActivityCategory, ActivityChannel, ActivityTargetType } from "./catalog";
import { cleanDetails, isKnownAction, safeText } from "./catalog";

/**
 * Where an event is recorded from: a request (its `executionCtx` lets the write finish after the response) or a
 * plain `{ env }` for jobs and tests. Without an execution context the write is awaited.
 */
export type ActivitySource =
  | Pick<Context, "env">
  | { env: { DB: D1Database }; waitUntil?: (work: Promise<unknown>) => void };

export interface ActivityActor {
  type: ActivityActorType;
  /** Employee id, administrator e-mail or customer id; null for the system. */
  id?: string | null;
  /** Looked up from the employees table when left out for an employee. */
  name?: string | null;
}

export interface ActivityTarget {
  type: ActivityTargetType;
  id: string;
  /** Looked up (customer, employee, phone model) when left out. */
  label?: string | null;
}

export interface ActivityEvent {
  actor: ActivityActor;
  channel: ActivityChannel;
  category: ActivityCategory;
  action: string;
  target?: ActivityTarget | null;
  details?: Record<string, unknown>;
  /** Kept only for sign-in events. */
  security?: { ip?: string | null; userAgent?: string | null };
  /** For tests; defaults to now. */
  at?: Date;
}

const BATCH_SIZE = 40;
const MERGE_WINDOW_MS = 15 * 60_000;
const TOUCH_INTERVAL_MS = 5 * 60_000;

function dbOf(source: ActivitySource): D1Database {
  return (source.env as { DB: D1Database }).DB;
}

/** Hands `work` to the platform to finish after the response; false when there is no execution context. */
function schedule(source: ActivitySource, work: Promise<unknown>): boolean {
  try {
    const executionCtx = (source as { executionCtx?: ExecutionContext }).executionCtx;
    if (executionCtx) {
      executionCtx.waitUntil(work);
      return true;
    }
  } catch {
    // Hono throws when the request has no execution context (tests, Node).
  }
  const waitUntil = (source as { waitUntil?: (work: Promise<unknown>) => void }).waitUntil;
  if (typeof waitUntil === "function") {
    waitUntil(work);
    return true;
  }
  return false;
}

/** Runs a write that must never fail or slow the caller: deferred when possible, errors reduced to a count. */
async function safely(source: ActivitySource, write: () => Promise<unknown>): Promise<void> {
  const work = (async () => {
    try {
      await write();
    } catch {
      // Counts only: never the event, the error text or any identifier.
      console.log(JSON.stringify({ job: "activity-log", status: "error", dropped: 1 }));
    }
  })();
  if (!schedule(source, work)) await work;
}

/** SQL that masks a name that is only a phone number, like `safeText`. */
const maskSql = (expression: string) =>
  `CASE WHEN ${expression} NOT GLOB '*[A-Za-z]*' AND ${expression} GLOB '*[0-9]*[0-9]*[0-9]*[0-9]*[0-9]*[0-9]*[0-9]*' THEN '••••' || substr(${expression}, -4) ELSE ${expression} END`;

const labelSql = (placeholderType: string, placeholderId: string) => `(SELECT ${maskSql("n")} FROM (SELECT CASE ${placeholderType}
  WHEN 'customer' THEN (SELECT name FROM customers WHERE id = ${placeholderId})
  WHEN 'employee' THEN (SELECT name FROM employees WHERE id = ${placeholderId})
  WHEN 'device' THEN (SELECT model FROM devices WHERE id = ${placeholderId}) END AS n))`;

const columns = `id, occurred_at, actor_type, actor_id, actor_name, category, action, target_type, target_id, target_label, channel, details, ip, user_agent`;
/** The values of one row; ?1..?14 as bound by `bindings`. Names the caller left out are read in the same statement. */
const values = `?1, ?2, ?3, ?4,
  COALESCE(?5, CASE ?3 WHEN 'employee' THEN (SELECT name FROM employees WHERE id = ?4)
    WHEN 'customer' THEN (SELECT ${maskSql("n")} FROM (SELECT name AS n FROM customers WHERE id = ?4)) END),
  ?6, ?7, ?8, ?9, COALESCE(?10, CASE WHEN ?9 IS NOT NULL THEN ${labelSql("?8", "?9")} END),
  ?11, ?12, ?13, ?14`;

function row(event: ActivityEvent, extraDetails?: Record<string, unknown>): { sql: unknown[]; valid: boolean } {
  const valid = isKnownAction(event.category, event.action);
  const secure = event.category === "signin";
  const details = cleanDetails(event.category, event.action, { ...event.details, ...extraDetails });
  return {
    valid,
    sql: [
      `act_${crypto.randomUUID()}`,
      (event.at ?? new Date()).toISOString(),
      event.actor.type,
      event.actor.id ?? null,
      event.actor.name ? safeText(event.actor.name, 200) : null,
      event.category,
      event.action,
      event.target?.type ?? null,
      event.target?.id ?? null,
      event.target?.label ? safeText(event.target.label, 200) : null,
      event.channel,
      JSON.stringify(details),
      secure ? event.security?.ip?.slice(0, 64) || null : null,
      secure ? event.security?.userAgent?.slice(0, 300) || null : null,
    ],
  };
}

function insertStatement(db: D1Database, event: ActivityEvent) {
  const { sql, valid } = row(event);
  return valid ? db.prepare(`INSERT INTO activity_log (${columns}) VALUES (${values})`).bind(...sql) : null;
}

/**
 * Records one event. NEVER throws and never makes the request wait: on a Worker the insert finishes after the
 * response; a failure is swallowed and only counted in the log. Unknown actions are dropped.
 */
export function recordActivity(source: ActivitySource, event: ActivityEvent): Promise<void> {
  return safely(source, async () => {
    const statement = insertStatement(dbOf(source), event);
    if (statement) await statement.run();
  });
}

/** Records many events (a bulk import) with a few round trips. Same guarantees as `recordActivity`. */
export function recordActivityBatch(source: ActivitySource, events: ActivityEvent[]): Promise<void> {
  if (events.length === 0) return Promise.resolve();
  return safely(source, async () => {
    const db = dbOf(source);
    const statements = events.flatMap((event) => insertStatement(db, event) ?? []);
    for (let start = 0; start < statements.length; start += BATCH_SIZE) await db.batch(statements.slice(start, start + BATCH_SIZE));
  });
}

/**
 * Records a burst of the same kind of event (phone syncs, recording uploads) as one row per target and 15 minutes:
 * a later event inside the window adds its numbers (`sum`) to the row and moves its time, instead of adding a row.
 * `since` in the details is when the row started.
 */
export function recordMergedActivity(
  source: ActivitySource, event: ActivityEvent & { target: ActivityTarget }, sum: Record<string, number>,
): Promise<void> {
  return safely(source, async () => {
    const db = dbOf(source);
    const now = event.at ?? new Date();
    const since = now.toISOString();
    const cutoff = new Date(now.getTime() - MERGE_WINDOW_MS).toISOString();
    const inserted = row(event, { ...sum, since });
    if (!inserted.valid) return;
    const keys = Object.keys(sum);
    if (keys.some((key) => !/^[A-Za-z]+$/.test(key))) throw new Error("Unsupported merge key");
    const recent = `SELECT id FROM activity_log WHERE category = ?1 AND action = ?2 AND target_id = ?3
      AND occurred_at >= ?4 AND json_extract(details, '$.since') >= ?4 ORDER BY occurred_at DESC LIMIT 1`;
    const sets = keys.map((_, index) => `'$.${keys[index]}', COALESCE(json_extract(details, '$.${keys[index]}'), 0) + ?${index + 5}`).join(", ");
    const insertValues = values.replace(/\?(\d+)/g, (_, number) => `?${Number(number) + 4}`);
    await db.batch([
      db.prepare(`UPDATE activity_log SET occurred_at = ?${keys.length + 5}, details = json_set(details, ${sets})
        WHERE id = (${recent})`)
        .bind(event.category, event.action, event.target.id, cutoff, ...keys.map((key) => sum[key]), since),
      // Inserts only when the update found no row inside the window; both statements run in one transaction.
      db.prepare(`INSERT INTO activity_log (${columns}) SELECT ${insertValues}
        WHERE NOT EXISTS (SELECT 1 FROM activity_log WHERE category = ?1 AND action = ?2 AND target_id = ?3 AND occurred_at >= ?4
          AND json_extract(details, '$.since') >= ?4)`)
        .bind(event.category, event.action, event.target.id, cutoff, ...inserted.sql),
    ]);
  });
}

// "Last active" is written at most once per employee and five minutes (per isolate; the SQL repeats the guard).
const touched = new WeakMap<D1Database, Map<string, number>>();

/** Notes that an employee just used the app or the web app. Cheap: usually no database work at all. */
export function touchEmployeeActivity(source: ActivitySource, employeeId: string, channel: "app" | "web", now = Date.now()): Promise<void> {
  const db = dbOf(source);
  let seen = touched.get(db);
  if (!seen) touched.set(db, (seen = new Map()));
  const previous = seen.get(employeeId);
  if (previous !== undefined && now - previous < TOUCH_INTERVAL_MS) return Promise.resolve();
  if (seen.size > 500) seen.clear();
  seen.set(employeeId, now);
  return safely(source, () => db.prepare(
    `INSERT INTO employee_activity_summary (employee_id, last_active_at, last_channel) VALUES (?1, ?2, ?3)
      ON CONFLICT(employee_id) DO UPDATE SET last_active_at = excluded.last_active_at, last_channel = excluded.last_channel
      WHERE employee_activity_summary.last_active_at <= ?4`,
  ).bind(employeeId, new Date(now).toISOString(), channel, new Date(now - TOUCH_INTERVAL_MS).toISOString()).run());
}

// ---- Who is calling ----

interface RequestContext {
  get(key: string): unknown;
  req: { header(name: string): string | undefined };
}

/** The employee, administrator and channel behind an authenticated request. */
export function requestActor(context: Context<any>): { actor: ActivityActor; channel: ActivityChannel } { // eslint-disable-line @typescript-eslint/no-explicit-any
  const loose = context as unknown as RequestContext;
  const web = loose.get("webSession") as { employee: { id: string; name: string } } | undefined;
  if (web) return { actor: { type: "employee", id: web.employee.id, name: web.employee.name }, channel: "web" };
  const device = loose.get("device") as { employeeId: string } | undefined;
  if (device) return { actor: { type: "employee", id: device.employeeId }, channel: "app" };
  const adminId = (loose.get("adminId") as string | undefined) ?? "local";
  return { actor: { type: "admin", id: adminId, name: adminId === "local" ? "Local admin" : adminId }, channel: "admin" };
}

/** IP and browser as sent by Cloudflare, for sign-in events. */
export function requestSecurity(context: Context<any>): { ip: string | null; userAgent: string | null } { // eslint-disable-line @typescript-eslint/no-explicit-any
  return { ip: context.req.header("CF-Connecting-IP") ?? null, userAgent: context.req.header("User-Agent") ?? null };
}
