import { z } from "zod";

import type { Env } from "../env";

const hour = 60 * 60 * 1000;
const istOffset = 5.5 * hour;
const callTypes = [
  ["incoming", "Incoming"],
  ["outgoing", "Outgoing"],
  ["missed", "Missed"],
  ["rejected", "Rejected"],
  ["blocked", "Blocked"],
  ["voicemail", "Voicemail"],
  ["answered_externally", "Answered elsewhere"],
  ["unknown", "Unknown"],
] as const;

type SummaryRow = {
  employeeId: string | null;
  employeeName: string;
  total: number;
  connected: number;
  uniqueContacts: number;
  durationSeconds: number;
  incomingSeconds: number;
  outgoingSeconds: number;
  employees: number;
} & Record<(typeof callTypes)[number][0], number>;

// IST has no daylight-saving transitions. Use the event's date, not execution time:
// a delayed invocation must still report the original day's fixed 6 PM cutoff.
export function reportWindow(scheduledTime: number) {
  const date = new Date(scheduledTime + istOffset).toISOString().slice(0, 10);
  const start = Date.parse(`${date}T00:00:00.000Z`) - istOffset;
  return {
    date,
    start: new Date(start).toISOString(),
    end: new Date(start + 18 * hour).toISOString(),
  };
}

export async function loadCallSummary(db: D1Database, scheduledTime: number) {
  const window = reportWindow(scheduledTime);
  const metrics = `COUNT(*) AS total,
    COUNT(CASE WHEN duration_seconds > 0 THEN 1 END) AS connected,
    COUNT(DISTINCT NULLIF(remote_number, '')) AS uniqueContacts,
    COALESCE(SUM(duration_seconds), 0) AS durationSeconds,
    COALESCE(SUM(CASE WHEN call_type = 'incoming' THEN duration_seconds END), 0) AS incomingSeconds,
    COALESCE(SUM(CASE WHEN call_type = 'outgoing' THEN duration_seconds END), 0) AS outgoingSeconds,
    COUNT(DISTINCT employee_id) AS employees,
    ${callTypes.map(([type]) =>
      `COUNT(CASE WHEN call_type = '${type}' THEN 1 END) AS ${type}`,
    ).join(", ")}`;
  // Aggregate the canonical history once, never the unified feed or recordings.
  // One statement gives global distinct-contact counts and a consistent snapshot.
  const { results } = await db.prepare(`
    WITH report_calls AS (
      SELECT l.employee_id, e.name AS employee_name,
        l.duration_seconds, l.call_type, l.remote_number
      FROM call_logs l JOIN employees e ON e.id = l.employee_id
      WHERE l.deleted_at IS NULL AND l.started_at >= ? AND l.started_at < ?
    )
    SELECT NULL AS employeeId, 'All employees' AS employeeName, ${metrics}
      FROM report_calls
    UNION ALL
    SELECT employee_id AS employeeId, employee_name AS employeeName, ${metrics}
      FROM report_calls GROUP BY employee_id, employee_name
  `).bind(window.start, window.end).all<SummaryRow>();
  const total = results.find((row) => row.employeeId === null)!;
  const employees = results.filter((row) => row.employeeId !== null)
    .sort((a, b) => b.total - a.total || a.employeeName.localeCompare(b.employeeName));
  return { window, total, employees };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function duration(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  // Short enough to sit under a count in a narrow phone column.
  return hours > 0 ? `${hours}h${pad(minutes)}m` : `${minutes}m${pad(seconds % 60)}s`;
}

// One compact table. "Other" folds the rarely used Android types so the table fits a phone screen.
function cells(row: SummaryRow) {
  return {
    other: row.blocked + row.voicemail + row.answered_externally + row.unknown,
    notConnected: row.total - row.connected,
  };
}

export function renderCallSummary(summary: Awaited<ReturnType<typeof loadCallSummary>>) {
  const subject = `Linekeep Daily Call Summary - ${summary.window.date}`;
  const coverage = `${summary.window.date} · 12:00 AM–6:00 PM IST`;
  const note = "Snapshot of call logs uploaded when this report was generated; later calls and uploads are not carried over. " +
    "Connected = logged duration above zero (time shown under the count). Unique = distinct stored numbers. " +
    "Other = blocked, voicemail, answered elsewhere and unknown. Deleted logs and recordings are not counted.";
  const rows = [...summary.employees, summary.total];
  const text = [subject, coverage, "",
    ...rows.map((row) => {
      const { other, notConnected } = cells(row);
      return `${row.employeeId === null ? "TOTAL" : row.employeeName}: total ${row.total}, connected ${row.connected} (${duration(row.durationSeconds)}), ` +
        `not connected ${notConnected}, unique ${row.uniqueContacts}, incoming ${row.incoming} (${duration(row.incomingSeconds)}), ` +
        `outgoing ${row.outgoing} (${duration(row.outgoingSeconds)}), missed ${row.missed}, rejected ${row.rejected}, other ${other}`;
    }), "", note,
  ].join("\n");
  const border = "border-bottom:1px solid #d9e2ec";
  const head = (label: string, align = "center") =>
    `<th style="padding:6px 1px;background:#1f3b4d;color:#ffffff;font-size:10px;font-weight:bold;text-align:${align};vertical-align:bottom">${label}</th>`;
  const num = (value: number | string, sub?: string, strong = false) =>
    `<td style="padding:7px 1px;${border};text-align:center;font-size:13px;color:#102a43;${strong ? "font-weight:bold;" : ""}vertical-align:top">${value}` +
    `${sub ? `<br><span style="font-size:10px;color:#3b6ea5;white-space:nowrap">${sub}</span>` : ""}</td>`;
  const body = rows.map((row) => {
    const { other, notConnected } = cells(row);
    const total = row.employeeId === null;
    const bg = total ? "background:#e8f1f8;" : "background:#ffffff;";
    return `<tr style="${bg}"><td style="padding:7px 4px;${border};font-size:12px;font-weight:bold;color:#102a43;text-align:left;vertical-align:top;min-width:52px">${total ? "Total" : escapeHtml(row.employeeName)}</td>` +
      num(row.total, undefined, true) + num(row.connected, duration(row.durationSeconds)) + num(notConnected) +
      num(row.uniqueContacts) + num(row.incoming, duration(row.incomingSeconds)) +
      num(row.outgoing, duration(row.outgoingSeconds)) + num(row.missed) + num(row.rejected) + num(other) + "</tr>";
  }).join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${subject}</title></head>
<body style="margin:0;padding:8px 4px;background:#eef2f6;font-family:Arial,Helvetica,sans-serif;color:#102a43">
<table role="presentation" style="width:100%;max-width:720px;margin:auto;border-collapse:collapse;background:#ffffff"><tr><td style="padding:20px;background:#103f3a;color:#ffffff">
<p style="margin:0 0 6px;font-size:12px;letter-spacing:2px;font-weight:bold">LINEKEEP</p><h1 style="margin:0 0 6px;font-size:22px;color:#ffffff">Daily call summary</h1>
<p style="margin:0;font-size:13px;color:#d6efe4">${coverage}</p></td></tr>
<tr><td style="padding:8px 4px">${summary.total.total === 0 ? '<p style="margin:8px;font-size:14px">No call logs are available for this reporting window.</p>' : ""}
<table aria-label="Call statistics" style="width:100%;border-collapse:collapse"><thead><tr>${head("Name", "left")}${head("Total")}${head("Conn.")}${head("Not conn.")}${head("Uniq.")}${head("In")}${head("Out")}${head("Miss")}${head("Rej.")}${head("Other")}</tr></thead>
<tbody>${body}</tbody></table></td></tr>
<tr><td style="padding:4px 16px 18px"><p style="margin:0 0 8px;font-size:11px;line-height:1.5;color:#52606d">${escapeHtml(note)}</p>
<p style="margin:0;font-size:11px;color:#52606d">Automated by Linekeep. No phone numbers or recordings are included.</p></td></tr></table></body></html>`;
  return { subject, text, html };
}

function mailConfiguration(env: Env) {
  try {
    const raw = env.EMAIL_IDS?.trim() ?? "";
    const recipients = z.array(z.email()).min(1).max(1000).parse(
      raw.startsWith("[") ? JSON.parse(raw) : raw.split(",").map((email) => email.trim()),
    );
    const domain = z.string().max(253).regex(
      /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/,
    ).parse(env.MAILGUN_DOMAIN);
    return {
      recipients: [...new Set(recipients)],
      domain,
      key: z.string().trim().min(1).parse(env.MAILGUN_API_KEY),
      sender: z.email().parse(env.MAILGUN_FROM_EMAIL ?? `postmaster@${domain}`),
      region: z.enum(["us", "eu"]).parse(env.MAILGUN_REGION ?? "us"),
    };
  } catch {
    // Zod/provider errors can include private values. Never propagate them to logs.
    throw new Error("Invalid call-summary email configuration; check EMAIL_IDS and MAILGUN settings");
  }
}

export async function sendCallSummary(scheduledTime: number, env: Env) {
  if (env.CALL_SUMMARY_ENABLED !== "true") return { status: "disabled" } as const;
  const config = mailConfiguration(env);
  const summary = await loadCallSummary(env.DB, scheduledTime);
  const report = renderCallSummary(summary);
  const body = new FormData();
  body.set("from", `Linekeep Reports <${config.sender}>`);
  for (const recipient of config.recipients) body.append("to", recipient);
  body.set("subject", report.subject);
  body.set("text", report.text);
  body.set("html", report.html);
  body.set("o:tracking", "no");
  body.set("o:tracking-clicks", "no");
  body.set("o:tracking-opens", "no");
  const host = config.region === "eu" ? "api.eu.mailgun.net" : "api.mailgun.net";
  const response = await fetch(`https://${host}/v3/${config.domain}/messages`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`api:${config.key}`)}` },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {
    throw new Error("Call-summary email request failed");
  });
  await response.body?.cancel();
  if (response.status !== 200) {
    throw new Error(`Call-summary email was not accepted (HTTP ${response.status})`);
  }
  return { status: "accepted", date: summary.window.date, calls: summary.total.total } as const;
}
