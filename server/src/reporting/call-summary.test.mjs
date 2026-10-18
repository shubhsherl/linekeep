import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";

import { createDatabase, loadModule } from "../data/test-support.mjs";

const { reportWindow, loadCallSummary, renderCallSummary, sendCallSummary } =
  await loadModule("../reporting/call-summary.ts");
const scheduledTime = Date.parse("2026-09-28T12:30:00.000Z");
const name = 'Old <script>alert("x")</script> & employee';

async function fixture(t) {
  const DB = await createDatabase(t);
  await DB.batch([
    DB.prepare("INSERT INTO employees (id, name, created_at) VALUES ('old', ?, '2026-01-01T00:00:00.000Z')").bind(name),
    DB.prepare("INSERT INTO employees (id, name, created_at) VALUES ('new', 'New employee', '2026-01-01T00:00:00.000Z')"),
    DB.prepare(`INSERT INTO devices (id, employee_id, token_hash, created_at, assigned_at)
      VALUES ('phone', 'old', 'synthetic-hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`),
  ]);
  let sequence = 0;
  async function add(startedAt, employee, type, seconds = 0, number = null, deleted = false) {
    sequence++;
    await DB.prepare(`INSERT INTO call_logs
      (id, device_id, employee_id, fingerprint, started_at, duration_seconds, call_type, remote_number, created_at, deleted_at)
      VALUES (?, 'phone', ?, ?, ?, ?, ?, ?, '2026-09-28T12:00:00.000Z', ?)`)
      .bind(`log-${sequence}`, employee, sequence.toString(16).padStart(64, "0"),
        startedAt, seconds, type, number, deleted ? "2026-09-28T12:15:00.000Z" : null).run();
  }
  return { DB, add };
}

test("IST report dates cross UTC, month and year boundaries without using tomorrow's midnight", () => {
  assert.deepEqual(reportWindow(Date.parse("2026-01-01T12:30:00.000Z")), {
    date: "2026-01-01", start: "2025-12-31T18:30:00.000Z", end: "2026-01-01T12:30:00.000Z",
  });
  assert.equal(reportWindow(Date.parse("2026-01-31T18:30:00.000Z")).date, "2026-02-01");
});

test("summary includes all types, fixed boundaries and historical owners without counting deleted logs or audio twice", async (t) => {
  const { DB, add } = await fixture(t);
  await add("2026-09-27T18:29:59.999Z", "old", "incoming", 900);
  await add("2026-09-27T18:30:00.000Z", "old", "incoming", 60, "+15555550100");
  await add("2026-09-28T08:00:00.000Z", "old", "outgoing", 0, "+15555550100");
  await add("2026-09-28T12:29:59.999Z", "old", "missed", 0, "+15555550200");
  await DB.prepare("UPDATE devices SET employee_id = 'new' WHERE id = 'phone'").run();
  await add("2026-09-28T11:00:00.000Z", "new", "outgoing", 120, "+15555550100");
  for (const type of ["rejected", "blocked", "voicemail", "answered_externally", "unknown"]) {
    await add("2026-09-28T11:01:00.000Z", "new", type, type === "answered_externally" ? 20 : 0);
  }
  await add("2026-09-28T12:30:00.000Z", "new", "incoming", 800);
  await add("2026-09-28T12:00:00.000Z", "new", "outgoing", 700, null, true);
  await DB.prepare(`INSERT INTO calls
    (id, employee_id, device_id, fingerprint, display_name, match_status, object_key, content_type, expected_bytes, upload_status, created_at)
    VALUES ('audio', 'new', 'phone', ?, 'Synthetic recording', 'unmatched', 'synthetic/audio', 'audio/mp4', 10, 'complete', '2026-09-28T11:00:00.000Z')`)
    .bind("f".repeat(64)).run();
  const summary = await loadCallSummary(DB, scheduledTime);
  assert.deepEqual(summary.total, {
    employeeId: null, employeeName: "All employees", total: 9, connected: 3,
    uniqueContacts: 2, durationSeconds: 200, incomingSeconds: 60, outgoingSeconds: 120, employees: 2,
    incoming: 1, outgoing: 2, missed: 1, rejected: 1, blocked: 1,
    voicemail: 1, answered_externally: 1, unknown: 1,
  });
  assert.equal(summary.employees.find((row) => row.employeeId === "old").total, 3);
  assert.equal(summary.employees.find((row) => row.employeeId === "new").total, 6);
  const report = renderCallSummary(summary);
  assert.ok(report.html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; employee"));
  assert.ok(!report.html.includes("<script>"));
  assert.ok(report.text.includes(name));
  // One table: a row per employee plus a total, with per-direction durations beneath the counts.
  assert.equal(report.html.match(/<table aria-label/g).length, 1);
  assert.equal(report.html.match(/<tbody>[\s\S]*<\/tbody>/)[0].match(/<tr /g).length, 3);
  assert.ok(report.text.includes("TOTAL: total 9, connected 3 (3m20s)"));
  assert.ok(report.text.includes("incoming 1 (1m00s), outgoing 2 (2m00s), missed 1, rejected 1, other 4"));
  for (const content of [report.html, report.text]) {
    assert.ok(!content.includes("+15555550100"));
    assert.ok(!content.includes("+15555550200"));
    assert.ok(!content.includes("synthetic/audio"));
  }
});

test("an empty reporting period has zero totals rather than null durations or stale data", async (t) => {
  const DB = await createDatabase(t);
  const summary = await loadCallSummary(DB, scheduledTime);
  assert.equal(summary.total.total, 0);
  assert.equal(summary.total.durationSeconds, 0);
  assert.deepEqual(summary.employees, []);
});

test("disabled reporting and invalid recipient lists cannot send call data", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network access"); });
  await sendCallSummary(scheduledTime, { CALL_SUMMARY_ENABLED: "false" });
  for (const EMAIL_IDS of ["", "approved@example.com,not-an-email", '["approved@example.com",42]']) {
    await assert.rejects(sendCallSummary(scheduledTime, {
      CALL_SUMMARY_ENABLED: "true", EMAIL_IDS, MAILGUN_DOMAIN: "example.com", MAILGUN_API_KEY: "synthetic-key",
    }));
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("provider rejection fails the job without leaking its response or credentials", async (t) => {
  const DB = await createDatabase(t);
  t.mock.method(globalThis, "fetch", async () => new Response(
    "private-provider-detail approved@example.com synthetic-private-key", { status: 429 },
  ));
  await assert.rejects(sendCallSummary(scheduledTime, {
    DB, CALL_SUMMARY_ENABLED: "true", EMAIL_IDS: "approved@example.com",
    MAILGUN_DOMAIN: "example.com", MAILGUN_API_KEY: "synthetic-private-key",
  }), (error) => {
    assert.ok(error.message.includes("429"));
    assert.ok(!error.message.includes("private-provider-detail"));
    assert.ok(!error.message.includes("approved@example.com"));
    assert.ok(!error.message.includes("synthetic-private-key"));
    return true;
  });
});

test("native Worker cron sends successfully and never forwards credentials through a provider redirect", async (t) => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../index.ts", import.meta.url))],
    bundle: true, format: "esm", platform: "browser", target: "es2022", write: false,
  });
  const settings = {
    CALL_SUMMARY_ENABLED: "true", EMAIL_IDS: "owner@example.com,manager@example.com",
    MAILGUN_DOMAIN: "example.com", MAILGUN_API_KEY: "synthetic-mailgun-key",
  };
  let redirect = false;
  const destinations = [];
  const messages = [];
  const runtime = new Miniflare({ workers: [{
    config: {
      name: "scheduled-report-regression", compatibilityDate: "2026-09-24",
      manifest: { mainModule: "index.js", modules: {
        "index.js": { type: "esm", contents: bundle.outputFiles[0].text },
      } },
      env: { DB: { type: "d1", id: "scheduled-report" },
        ...Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, { type: "text", value }])),
      },
    },
    dev: { outboundService: { type: "fetcher", async handler(request) {
      destinations.push(new URL(request.url).hostname);
      if (redirect) return Response.redirect("https://untrusted.example/collect", 302);
      messages.push(await request.formData());
      return Response.json({ id: "synthetic-receipt", message: "Queued" });
    } } },
  }] });
  t.after(() => runtime.dispose());
  const DB = await runtime.getD1Database("DB");
  const migrations = new URL("../../migrations/", import.meta.url);
  for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
    const statements = unstable_splitSqlQuery(await readFile(new URL(name, migrations), "utf8"));
    await DB.batch(statements.map((statement) => DB.prepare(statement)));
  }
  const worker = await runtime.getWorker();
  const event = { cron: "30 12 * * *", scheduledTime: new Date(scheduledTime) };
  assert.equal((await worker.scheduled(event)).outcome, "ok");
  assert.deepEqual(messages[0].getAll("to"), ["owner@example.com", "manager@example.com"]);
  assert.ok(messages[0].get("text").includes("TOTAL: total 0, connected 0 (0m00s)"));
  redirect = true;
  assert.equal((await worker.scheduled(event)).outcome, "exception");
  assert.deepEqual(destinations, ["api.mailgun.net", "api.mailgun.net"]);
});
