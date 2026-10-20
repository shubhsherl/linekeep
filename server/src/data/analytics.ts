import { z } from "zod";

import { callType } from "./call-history";

const minute = 60 * 1000;
const day = 24 * 60 * minute;
// IST (Asia/Kolkata) has no daylight-saving transitions: a fixed +05:30 offset is exact.
const istOffsetMinutes = 330;
const istOffset = istOffsetMinutes * minute;
const maxDays = 366;
const maxEmployees = 50;

export const callTypes = callType.options;
export type AnalyticsCallType = (typeof callTypes)[number];
export const durationBucketKeys = ["1-29s", "30-59s", "1-3m", "3-10m", "10m+"] as const;

export interface AnalyticsMetrics {
  total: number;
  connected: number;
  notConnected: number;
  uniqueContacts: number;
  talkSeconds: number;
  avgConnectedSeconds: number;
  incoming: number;
  incomingSeconds: number;
  outgoing: number;
  outgoingSeconds: number;
  missed: number;
  rejected: number;
  other: number;
  withRecording: number;
}
export type EmployeeAnalytics = AnalyticsMetrics & { id: string; name: string };
export interface CallAnalytics {
  range: {
    from: string;
    to: string;
    days: number;
    timezone: "Asia/Kolkata";
    previousFrom: string;
    previousTo: string;
  };
  totals: AnalyticsMetrics;
  previous: AnalyticsMetrics;
  employees: EmployeeAnalytics[];
  byType: { type: AnalyticsCallType; count: number; seconds: number }[];
  byDay: {
    date: string;
    total: number;
    connected: number;
    talkSeconds: number;
    types: Record<AnalyticsCallType, { count: number; seconds: number }>;
  }[];
  byHourWeekday: { weekday: number; hour: number; count: number }[];
  durationBuckets: { key: string; label: string; count: number }[];
}

export function istDate(now: Date): string {
  return new Date(now.getTime() + istOffset).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * day).toISOString().slice(0, 10);
}

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});

const employeeIds = z.string().max(4096).transform((value) => value.split(",")).pipe(
  z.array(z.string().regex(/^emp_[A-Za-z0-9_-]{1,128}$/)).min(1).max(maxEmployees),
).transform((values) => [...new Set(values)]);

const callTypeList = z.string().max(256).transform((value) => value.split(",")).pipe(
  z.array(callType).min(1).max(callTypes.length),
).transform((values) => [...new Set(values)]);

/**
 * Query string values for `GET /v1/admin/analytics/calls`. `today` (IST date) supplies the
 * defaults: `to` = today, `from` = `to` - 6 days. Resolves to a validated range.
 */
export function analyticsQuery(today: string): z.ZodType<AnalyticsInput, Record<string, string>> {
  return z.strictObject({
    from: calendarDate.optional(),
    to: calendarDate.optional(),
    employeeIds: employeeIds.optional(),
    callTypes: callTypeList.optional(),
  }).transform((value, context) => {
    const to = value.to ?? today;
    const from = value.from ?? addDays(to, -6);
    const days = Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / day) + 1;
    if (days < 1 || days > maxDays) {
      context.addIssue({ code: "custom", message: "Invalid date range" });
      return z.NEVER;
    }
    return { from, to, days, employeeIds: value.employeeIds, callTypes: value.callTypes };
  });
}

/** Validated, fully resolved query: inclusive IST dates and the day count. */
export interface AnalyticsInput {
  from: string;
  to: string;
  days: number;
  employeeIds: string[] | undefined;
  callTypes: AnalyticsCallType[] | undefined;
}

// Window [00:00 IST of `from`, 00:00 IST of the day after `to`) as canonical UTC timestamps,
// the format `started_at` is always stored in.
function window(from: string, to: string) {
  return {
    start: new Date(Date.parse(`${from}T00:00:00.000Z`) - istOffset).toISOString(),
    end: new Date(Date.parse(`${to}T00:00:00.000Z`) + day - istOffset).toISOString(),
  };
}

type MetricRow = {
  employeeId: string | null;
  employeeName: string | null;
  total: number;
  connected: number;
  uniqueContacts: number;
  talkSeconds: number;
  incomingSeconds: number;
  outgoingSeconds: number;
  withRecording: number;
} & Record<AnalyticsCallType, number>;

// Same connected/unique/type definitions as the daily email (reporting/call-summary.ts).
const metricColumns = `COUNT(*) AS total,
  COUNT(CASE WHEN duration_seconds > 0 THEN 1 END) AS connected,
  COUNT(DISTINCT NULLIF(remote_number, '')) AS uniqueContacts,
  COALESCE(SUM(duration_seconds), 0) AS talkSeconds,
  COALESCE(SUM(CASE WHEN call_type = 'incoming' THEN duration_seconds END), 0) AS incomingSeconds,
  COALESCE(SUM(CASE WHEN call_type = 'outgoing' THEN duration_seconds END), 0) AS outgoingSeconds,
  COALESCE(SUM(has_recording), 0) AS withRecording,
  ${callTypes.map((type) => `COUNT(CASE WHEN call_type = '${type}' THEN 1 END) AS ${type}`).join(", ")}`;

function metrics(row: MetricRow | undefined): AnalyticsMetrics {
  const value = row ?? ({} as Partial<MetricRow>);
  const n = (key: keyof MetricRow) => Number(value[key] ?? 0);
  const total = n("total");
  const connected = n("connected");
  const talkSeconds = n("talkSeconds");
  return {
    total,
    connected,
    notConnected: total - connected,
    uniqueContacts: n("uniqueContacts"),
    talkSeconds,
    avgConnectedSeconds: connected > 0 ? Math.round(talkSeconds / connected) : 0,
    incoming: n("incoming"),
    incomingSeconds: n("incomingSeconds"),
    outgoing: n("outgoing"),
    outgoingSeconds: n("outgoingSeconds"),
    missed: n("missed"),
    rejected: n("rejected"),
    other: n("blocked") + n("voicemail") + n("answered_externally") + n("unknown"),
    withRecording: n("withRecording"),
  };
}

export function createAnalyticsRepository(db: D1Database) {
  return {
    /** Read-only aggregates over undeleted call history; exactly one D1 batch of 5 statements. */
    async calls(input: AnalyticsInput): Promise<CallAnalytics> {
      const current = window(input.from, input.to);
      const previousFrom = addDays(input.from, -input.days);
      const previousTo = addDays(input.from, -1);
      const previous = window(previousFrom, previousTo);

      const filters = [
        input.employeeIds ? `AND l.employee_id IN (${input.employeeIds.map(() => "?").join(",")})` : "",
        input.callTypes ? `AND l.call_type IN (${input.callTypes.map(() => "?").join(",")})` : "",
      ].join(" ");
      const scope = (bounds: { start: string; end: string }) => ({
        where: `l.deleted_at IS NULL AND l.started_at >= ? AND l.started_at < ? ${filters}`,
        binds: [bounds.start, bounds.end, ...(input.employeeIds ?? []), ...(input.callTypes ?? [])],
      });
      // Calls with a completed, non-deleted recording linked through calls.call_log_id.
      // Uncorrelated IN: SQLite builds the set of linked call-log ids once per statement. A correlated EXISTS was
      // planned as a full scan of `calls` for every call-log row (millions of rows read for a week of history).
      const hasRecording = `l.id IN (SELECT r.call_log_id FROM calls r INDEXED BY calls_linked_idx WHERE r.call_log_id IS NOT NULL
        AND r.upload_status = 'complete' AND r.deleted_at IS NULL)`;
      const scoped = (bounds: { start: string; end: string }) => {
        const { where, binds } = scope(bounds);
        return {
          binds,
          cte: `WITH scoped AS (
            SELECT l.employee_id, e.name AS employee_name, l.duration_seconds, l.call_type,
              l.remote_number, ${hasRecording} AS has_recording
            FROM call_logs l JOIN employees e ON e.id = l.employee_id
            WHERE ${where}
          )`,
        };
      };

      const now = scoped(current);
      const before = scoped(previous);
      const { where, binds } = scope(current);
      const ist = "l.started_at, '+330 minutes'";

      const [scopeResult, previousResult, dayResult, hourResult, bucketResult] = await db.batch([
        // Totals (NULL employee) plus one row per employee from one materialized scan.
        db.prepare(`${now.cte}
          SELECT NULL AS employeeId, NULL AS employeeName, ${metricColumns} FROM scoped
          UNION ALL
          SELECT employee_id, employee_name, ${metricColumns} FROM scoped
          GROUP BY employee_id, employee_name`).bind(...now.binds),
        db.prepare(`${before.cte} SELECT ${metricColumns} FROM scoped`).bind(...before.binds),
        db.prepare(`SELECT date(${ist}) AS day, l.call_type AS type, COUNT(*) AS count,
            COALESCE(SUM(l.duration_seconds), 0) AS seconds,
            COUNT(CASE WHEN l.duration_seconds > 0 THEN 1 END) AS connected
          FROM call_logs l WHERE ${where} GROUP BY day, type`).bind(...binds),
        db.prepare(`SELECT CAST(strftime('%w', ${ist}) AS INTEGER) AS weekday,
            CAST(strftime('%H', ${ist}) AS INTEGER) AS hour, COUNT(*) AS count
          FROM call_logs l WHERE ${where} GROUP BY weekday, hour`).bind(...binds),
        db.prepare(`SELECT CASE WHEN l.duration_seconds < 30 THEN 0 WHEN l.duration_seconds < 60 THEN 1
              WHEN l.duration_seconds < 180 THEN 2 WHEN l.duration_seconds < 600 THEN 3 ELSE 4 END AS bucket,
            COUNT(*) AS count
          FROM call_logs l WHERE ${where} AND l.duration_seconds > 0 GROUP BY bucket`).bind(...binds),
      ]);

      const metricRows = scopeResult.results as MetricRow[];
      const employees = metricRows
        .filter((row) => row.employeeId !== null)
        .map((row) => ({ id: row.employeeId!, name: row.employeeName!, ...metrics(row) }))
        .sort((a, b) =>
          b.total - a.total || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      const emptyTypes = () => Object.fromEntries(
        callTypes.map((type) => [type, { count: 0, seconds: 0 }]),
      ) as Record<AnalyticsCallType, { count: number; seconds: number }>;
      const byDay = new Map<string, CallAnalytics["byDay"][number]>();
      for (let offset = 0; offset < input.days; offset += 1) {
        const date = addDays(input.from, offset);
        byDay.set(date, { date, total: 0, connected: 0, talkSeconds: 0, types: emptyTypes() });
      }
      const byType = new Map(callTypes.map((type) => [type, { type, count: 0, seconds: 0 }]));
      for (const row of dayResult.results as { day: string; type: AnalyticsCallType; count: number; seconds: number; connected: number }[]) {
        const entry = byDay.get(row.day);
        const typeTotal = byType.get(row.type);
        if (!entry || !typeTotal) continue;
        entry.total += row.count;
        entry.connected += row.connected;
        entry.talkSeconds += row.seconds;
        entry.types[row.type] = { count: row.count, seconds: row.seconds };
        typeTotal.count += row.count;
        typeTotal.seconds += row.seconds;
      }

      const cells = new Array<number>(7 * 24).fill(0);
      for (const row of hourResult.results as { weekday: number; hour: number; count: number }[]) {
        cells[row.weekday * 24 + row.hour] = row.count;
      }
      const buckets = new Array<number>(durationBucketKeys.length).fill(0);
      for (const row of bucketResult.results as { bucket: number; count: number }[]) {
        buckets[row.bucket] = row.count;
      }

      return {
        range: {
          from: input.from,
          to: input.to,
          days: input.days,
          timezone: "Asia/Kolkata",
          previousFrom,
          previousTo,
        },
        totals: metrics(metricRows.find((row) => row.employeeId === null)),
        previous: metrics((previousResult.results as MetricRow[])[0]),
        employees,
        byType: [...byType.values()],
        byDay: [...byDay.values()],
        byHourWeekday: cells.map((count, index) => ({
          weekday: Math.floor(index / 24), hour: index % 24, count,
        })),
        durationBuckets: durationBucketKeys.map((key, index) => ({
          key, label: key, count: buckets[index],
        })),
      };
    },
  };
}
