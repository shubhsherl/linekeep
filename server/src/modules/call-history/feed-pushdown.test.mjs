import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase, loadModule } from "../../data/test-support.mjs";

const { createCallHistoryRepository } = await loadModule("./call-history.ts");

const iso = (ms) => new Date(ms).toISOString();
const fp = (n) => n.toString(16).padStart(64, "0");
function random(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }

/** The previous implementation, verbatim in structure: whole-feed CTE, filter, order, limit, then join audio. */
async function legacyList(DB, value) {
  const conditions = []; const bindings = [];
  if (value.employeeId !== undefined) { conditions.push("c.employee_id = ?"); bindings.push(value.employeeId); }
  if (value.callType !== undefined) { conditions.push("c.call_type = ?"); bindings.push(value.callType); }
  if (value.number !== undefined) { conditions.push("c.remote_number LIKE ? ESCAPE '\\'"); bindings.push(`%${value.number.replace(/[\\%_]/g, "\\$&")}%`); }
  if (value.from !== undefined) { conditions.push("c.sort_at >= ?"); bindings.push(value.from); }
  if (value.to !== undefined) { conditions.push("c.sort_at <= ?"); bindings.push(value.to); }
  if (value.cursor) { conditions.push("(c.sort_at, c.id) < (?, ?)"); bindings.push(value.cursor.sortAt, value.cursor.id); }
  if (value.hasRecording) conditions.push("c.has_recording = 1");
  const limit = value.limit ?? 50;
  const rows = (await DB.prepare(`
    WITH feed AS (
      SELECT 'call' AS kind, h.id, h.device_id, h.employee_id, h.started_at, h.started_at AS sort_at, h.duration_seconds, h.call_type,
        h.remote_number, h.caller_name, h.local_number, h.sim_label, h.phone_account_id, h.created_at,
        EXISTS (SELECT 1 FROM calls r WHERE r.call_log_id = h.id AND r.upload_status = 'complete') AS has_recording
      FROM call_logs h WHERE h.deleted_at IS NULL
      UNION ALL
      SELECT 'recording', r.id, r.device_id, r.employee_id, r.recorded_at, COALESCE(r.recorded_at, r.created_at), NULL, NULL,
        r.remote_number, NULL, NULL, NULL, NULL, r.created_at, r.upload_status = 'complete'
      FROM calls r WHERE r.call_log_id IS NULL AND r.upload_status <> 'deleted'
    ), page AS (
      SELECT c.* FROM feed c ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY c.sort_at DESC, c.id DESC LIMIT ?
    )
    SELECT r.id AS rid, p.kind, p.id AS feed_id, p.started_at, p.created_at
    FROM page p JOIN employees e ON e.id = p.employee_id
    LEFT JOIN calls r ON r.upload_status <> 'deleted' AND ((p.kind = 'call' AND r.call_log_id = p.id) OR (p.kind = 'recording' AND r.id = p.id))
    ORDER BY p.sort_at DESC, p.id DESC, r.created_at DESC, r.id DESC
  `).bind(...bindings, limit + 1).all()).results;
  const items = []; let key = "";
  for (const row of rows) {
    const k = `${row.kind}:${row.feed_id}`;
    if (k !== key) { key = k; items.push({ kind: row.kind, id: row.feed_id, started: row.started_at ?? undefined, created: row.created_at, recs: [] }); }
    if (row.rid) items.at(-1).recs.push(row.rid);
  }
  const more = items.length > limit; if (more) items.pop();
  const last = items.at(-1);
  return { items: items.map(({ kind, id, recs }) => ({ kind, id, recs })), nextCursor: more && last ? { sortAt: last.started ?? last.created, id: last.id } : null };
}

async function walk(fetchPage, limit) {
  const out = []; let cursor; let pages = 0;
  do {
    const page = await fetchPage({ limit, ...(cursor ? { cursor } : {}) });
    out.push(...page.items.map((i) => [i.kind, i.id, i.recs.join(",")]));
    cursor = page.nextCursor ?? undefined;
  } while (cursor && ++pages < 500);
  return out;
}

test("pushed-down feed returns exactly what the whole-feed query returned, across filters, ties, cursors and audio states", async (t) => {
  const DB = await createDatabase(t);
  const next = random(17);
  const base = Date.parse("2026-09-01T04:00:00.000Z");
  const emps = ["e0", "e1", "e2"];
  await DB.batch([
    ...emps.map((e, i) => DB.prepare("INSERT INTO employees (id, name, created_at) VALUES (?, ?, ?)").bind(e, `Emp ${i}`, iso(base))),
    ...emps.map((e, i) => DB.prepare("INSERT INTO devices (id, employee_id, token_hash, created_at, assigned_at) VALUES (?, ?, ?, ?, ?)").bind(`d${i}`, e, `h${i}`, iso(base), iso(base))),
  ]);
  const types = ["incoming", "outgoing", "missed", "rejected", "unknown"];
  const logs = [];
  for (let i = 0; i < 360; i++) {
    const e = i % 3;
    // 45 distinct timestamps => many ties on sort_at, exercising the id tie-break across both sources
    const start = base + Math.floor(next() * 45) * 3600000;
    logs.push({ id: `log${String(i).padStart(4, "0")}`, e, start, dur: next() < 0.5 ? 0 : 1 + Math.floor(next() * 90), type: types[Math.floor(next() * 5)], number: `+9199${String(Math.floor(next() * 30)).padStart(4, "0")}00` });
  }
  const log = (l) => DB.prepare(`INSERT INTO call_logs (id, device_id, employee_id, fingerprint, started_at, duration_seconds, call_type, remote_number, created_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(l.id, `d${l.e}`, `e${l.e}`, fp(l.id.length * 9973 + Number(l.id.slice(3))), iso(l.start), l.dur, l.type, l.number, iso(l.start), next() < 0.08 ? iso(base) : null);
  for (let i = 0; i < logs.length; i += 40) await DB.batch(logs.slice(i, i + 40).map(log));
  const states = ["complete", "complete", "complete", "pending", "failed", "deleted"];
  const recs = [];
  for (let i = 0; i < 240; i++) {
    const e = i % 3, state = states[Math.floor(next() * states.length)];
    const when = base + Math.floor(next() * 45) * 3600000;
    recs.push({ id: `rec${String(i).padStart(4, "0")}`, e, state, recordedAt: next() < 0.15 ? null : when, created: base + Math.floor(next() * 45) * 3600000, number: `+9199${String(Math.floor(next() * 30)).padStart(4, "0")}00`, link: next() < 0.45 ? logs[Math.floor(next() * logs.length)].id : null });
  }
  const rec = (r) => DB.prepare(`INSERT INTO calls (id, employee_id, device_id, fingerprint, display_name, remote_number, direction, recorded_at, duration_seconds,
    match_status, object_key, content_type, expected_bytes, upload_status, created_at, call_log_id) VALUES (?, ?, ?, ?, ?, ?, 'outgoing', ?, 30, 'media_metadata', ?, 'audio/mp4', 10, ?, ?, ?)`)
    .bind(r.id, `e${r.e}`, `d${r.e}`, fp(500000 + Number(r.id.slice(3))), `${r.id}.m4a`, r.number, r.recordedAt === null ? null : iso(r.recordedAt), `k/${r.id}`, r.state, iso(r.created), r.link);
  for (let i = 0; i < recs.length; i += 40) await DB.batch(recs.slice(i, i + 40).map(rec));
  // Insert triggers recompute links; set the attachments afterwards (updating call_log_id fires no trigger).
  const linked = recs.filter((r) => r.link);
  for (let i = 0; i < linked.length; i += 40) await DB.batch(linked.slice(i, i + 40).map((r) => DB.prepare("UPDATE calls SET call_log_id = ? WHERE id = ?").bind(r.link, r.id)));
  await DB.prepare("ANALYZE").run().catch(() => {});

  const repo = createCallHistoryRepository(DB);
  const from = iso(base + 10 * 3600000), to = iso(base + 30 * 3600000);
  const combos = [
    {}, { employeeId: "e1" }, { callType: "missed" }, { callType: "outgoing", employeeId: "e2" }, { number: "9912" },
    { number: "99%" }, { from, to }, { from }, { to }, { hasRecording: true }, { hasRecording: true, employeeId: "e0" },
    { employeeId: "e0", from, to, number: "99" }, { callType: "incoming", from, to, hasRecording: true },
  ];
  let compared = 0, nonEmpty = 0;
  for (const filters of combos) {
    for (const limit of [1, 7, 50, 100]) {
      const expected = await walk((p) => legacyList(DB, { ...filters, ...p }), limit);
      const actual = await walk((p) => repo.list({ ...filters, ...p }).then((r) => ({ items: r.items.map((i) => ({ kind: i.kind, id: i.id, recs: i.recordings.map((x) => x.id) })), nextCursor: r.nextCursor })), limit);
      assert.deepEqual(actual, expected, `filters ${JSON.stringify(filters)} limit ${limit}`);
      compared += 1; if (expected.length) nonEmpty += 1;
    }
  }
  assert.ok(compared === combos.length * 4 && nonEmpty >= 40, `vacuous comparison: ${nonEmpty} non-empty of ${compared}`);
  // The workload must exercise both sources, ties and attachments or the equality above proves little.
  const all = await walk((p) => legacyList(DB, p), 100);
  assert.ok(all.some((r) => r[0] === "recording") && all.some((r) => r[0] === "call" && r[2]), "needs unlinked audio and calls with audio");
});
