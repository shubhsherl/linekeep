import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase, loadModule } from "../../data/test-support.mjs";

const { createCallHistoryRepository } = await loadModule("./call-history.ts");

const iso = (ms) => new Date(ms).toISOString();
const fingerprint = (n) => n.toString(16).padStart(64, "0");

function random(seed) {
  let state = seed;
  return () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

async function baseRows(DB) {
  await DB.batch([
    DB.prepare("INSERT INTO employees (id, name, created_at) VALUES ('emp', 'Synthetic', '2026-01-01T00:00:00.000Z')"),
    DB.prepare("INSERT INTO devices (id, employee_id, token_hash, created_at, assigned_at) VALUES ('dev', 'emp', 'synthetic-hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"),
  ]);
}

const insertLog = (DB, l) => DB.prepare(`INSERT INTO call_logs (id, device_id, employee_id, fingerprint, started_at, duration_seconds,
  call_type, remote_number, caller_name, created_at) VALUES (?, 'dev', 'emp', ?, ?, ?, ?, ?, ?, ?)`)
  .bind(l.id, fingerprint(l.n), iso(l.start), l.duration, l.type, l.number, l.name, iso(l.start));
const insertRecording = (DB, r) => DB.prepare(`INSERT INTO calls (id, employee_id, device_id, fingerprint, display_name, remote_number,
  direction, recorded_at, duration_seconds, match_status, object_key, content_type, expected_bytes, upload_status, created_at)
  VALUES (?, 'emp', 'dev', ?, ?, ?, ?, ?, ?, 'media_metadata', ?, 'audio/mp4', 10, 'complete', ?)`)
  .bind(r.id, fingerprint(100000 + r.n), r.fileName, r.number, r.direction, r.recordedAt === null ? null : iso(r.recordedAt), r.duration, `k/${r.id}`, iso(r.createdAt));

/** A deterministic workload hitting every association rule, boundary and arrival order. */
function workload(seed) {
  const next = random(seed);
  const base = Date.parse("2026-09-01T04:00:00.000Z");
  const logs = [];
  const recordings = [];
  const wall = (ms) => {
    const d = new Date(ms + 19800000); // IST wall clock in the Samsung filename
    const p = (v) => String(v).padStart(2, "0");
    return `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  };
  for (let i = 0; i < 260; i++) {
    const start = base + i * 41000 + Math.floor(next() * 20000) * 1; // dense: calls start seconds apart
    const connected = next() < 0.7;
    const duration = connected ? 3 + Math.floor(next() * 14) : 0; // clustered durations => many near-duration candidates
    const type = !connected ? "missed" : next() < 0.8 ? "outgoing" : "incoming";
    const number = `+9199${String(Math.floor(next() * 25)).padStart(4, "0")}0000`;
    const name = next() < 0.4 ? `Contact ${i % 9}` : null;
    logs.push({ id: `log${i}`, n: i, start: Math.floor(start / 1000) * 1000, duration, type, number, name });
  }
  let r = 0;
  for (const l of logs.filter((x) => x.duration > 0)) {
    const roll = next();
    const mk = (extra) => recordings.push({ id: `rec${r}`, n: r++, number: l.number, direction: l.type, createdAt: l.start, ...extra });
    if (roll < 0.2) mk({ fileName: "x.m4a", recordedAt: l.start, duration: l.duration }); // exact-second rule
    else if (roll < 0.35) mk({ fileName: "x.m4a", recordedAt: l.start + 1000, duration: l.duration }); // off by one second: no match
    else if (roll < 0.55) { // Samsung: embedded END after the call
      const end = l.start + (l.duration + Math.floor(next() * 33)) * 1000;
      mk({ fileName: `Call ${l.name ?? l.number.replace("+", "")}_${wall(end)}.m4a`, recordedAt: end, duration: l.duration + (next() < 0.5 ? 0 : 1) });
    } else if (roll < 0.7) { // Samsung: embedded START offset 0..40 s
      const start = l.start + Math.floor(next() * 41) * 1000;
      mk({ fileName: `Call ${l.name ?? l.number.replace("+", "")}_${wall(start + l.duration * 1000)}.m4a`, recordedAt: start + l.duration * 1000, duration: l.duration });
    } else if (roll < 0.8) mk({ fileName: "x.m4a", recordedAt: l.start + 3600000, duration: l.duration }); // far decoy, similar duration
    else if (roll < 0.85) mk({ fileName: "x.m4a", recordedAt: null, duration: l.duration }); // no source time
  }
  // Arrival order: interleave logs and recordings, some recordings before their call.
  const ops = [...logs.map((x) => ({ kind: "log", x })), ...recordings.map((x) => ({ kind: "rec", x }))];
  ops.sort(() => next() - 0.5);
  const edits = logs.filter(() => next() < 0.15).map((l) => ({ id: l.id, duration: Math.max(1, l.duration + [-3, -1, 1, 2, 3][Math.floor(next() * 5)]), name: next() < 0.5 ? "Renamed" : l.name }));
  const deletes = logs.filter(() => next() < 0.07).map((l) => l.id);
  return { ops, edits, deletes };
}

async function run(DB, w) {
  await baseRows(DB);
  for (let i = 0; i < w.ops.length; i += 40) {
    await DB.batch(w.ops.slice(i, i + 40).map(({ kind, x }) => (kind === "log" ? insertLog(DB, x) : insertRecording(DB, x))));
  }
  for (const e of w.edits) await DB.prepare("UPDATE call_logs SET duration_seconds = ?, caller_name = ? WHERE id = ?").bind(e.duration, e.name, e.id).run();
  for (const id of w.deletes) await DB.prepare("UPDATE call_logs SET deleted_at = '2026-10-01T00:00:00.000Z' WHERE id = ?").bind(id).run();
}

const links = async (DB) => (await DB.prepare("SELECT id, call_log_id FROM calls ORDER BY id").all()).results;
const candidates = async (DB) => (await DB.prepare("SELECT recording_id, call_log_id, deleted_at FROM recording_call_candidates ORDER BY recording_id, call_log_id").all()).results;

test("time-bounded association yields exactly the links and candidates of the previous definition", async (t) => {
  for (const seed of [11, 29]) {
    const before = await createDatabase(t, "0008_customers.sql");
    const after = await createDatabase(t);
    const w = workload(seed);
    await run(before, w);
    await run(after, w);
    const expected = await links(before);
    const actual = await links(after);
    assert.ok(expected.filter((row) => row.call_log_id).length >= 20, "workload must produce many links to be meaningful");
    assert.ok(expected.filter((row) => !row.call_log_id).length >= 20, "and many non-links (decoys, ambiguity, boundary)");
    assert.deepEqual(actual, expected, `seed ${seed}: links differ`);
    assert.deepEqual(await candidates(after), await candidates(before), `seed ${seed}: candidate sets differ`);
  }
});

test("a new call, a replay and an arriving recording touch only a handful of rows even with dense history", async (t) => {
  const DB = await createDatabase(t);
  await baseRows(DB);
  const w = workload(5);
  for (let i = 0; i < w.ops.length; i += 40) {
    await DB.batch(w.ops.slice(i, i + 40).map(({ kind, x }) => (kind === "log" ? insertLog(DB, x) : insertRecording(DB, x))));
  }
  const rowCount = (await DB.prepare("SELECT (SELECT count(*) FROM call_logs) logs, (SELECT count(*) FROM calls) recordings").first());
  assert.ok(rowCount.logs >= 250 && rowCount.recordings >= 100);
  const last = Date.parse("2026-09-01T04:00:00.000Z") + 300 * 41000;
  // Same duration as many existing calls and recordings: the worst case for the old duration-keyed scan.
  const created = await insertLog(DB, { id: "fresh", n: 5000, start: last, duration: 9, type: "outgoing", number: "+919900000001", name: null }).run();
  assert.ok(created.meta.rows_read <= 40, `new call read ${created.meta.rows_read} rows`);
  assert.ok(created.meta.rows_written <= 12, `new call wrote ${created.meta.rows_written} rows`);
  const arrived = await insertRecording(DB, { id: "rec-fresh", n: 5000, number: "+919900000001", direction: "outgoing", createdAt: last, fileName: "x.m4a", recordedAt: last + 40000, duration: 9 }).run();
  assert.ok(arrived.meta.rows_read <= 40, `new recording read ${arrived.meta.rows_read} rows`);

  // Replay through the real repository: an unchanged entry must be a no-op for storage.
  const metas = [];
  const spy = { prepare: (q) => DB.prepare(q), batch: async (s) => { const r = await DB.batch(s); metas.push(...r.map((x) => x.meta)); return r; } };
  const entry = { fingerprint: fingerprint(70000), startedAt: iso(Date.parse("2026-09-01T04:00:00.000Z") + 7 * 41000 + 500000), durationSeconds: 5, callType: "outgoing", remoteNumber: "+919900000002" };
  const repo = createCallHistoryRepository(spy, () => new Date("2026-10-01T00:00:00Z"));
  await repo.upsertBatch("dev", { deviceId: "dev", entries: [entry] });
  metas.length = 0;
  await repo.upsertBatch("dev", { deviceId: "dev", entries: [entry] });
  const written = metas.reduce((sum, meta) => sum + meta.rows_written, 0);
  const read = metas.reduce((sum, meta) => sum + meta.rows_read, 0);
  assert.equal(written, 0, `an unchanged replay wrote ${written} rows`);
  assert.ok(read <= 40, `an unchanged replay read ${read} rows`);
  // A real change still applies.
  await repo.upsertBatch("dev", { deviceId: "dev", entries: [{ ...entry, durationSeconds: 6 }] });
  assert.equal((await DB.prepare("SELECT duration_seconds d FROM call_logs WHERE fingerprint = ?").bind(entry.fingerprint).first()).d, 6);
});
