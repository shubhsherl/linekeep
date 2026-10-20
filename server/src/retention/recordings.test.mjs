import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { Miniflare } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";

import { loadModule } from "../data/test-support.mjs";

const { purgeExpiredRecordings, retentionDays } = await loadModule("../retention/recordings.ts");
const now = Date.parse("2026-10-18T12:00:00.000Z");
const days = (count) => new Date(now - count * 86400000).toISOString();

async function fixture(t) {
  const runtime = new Miniflare({
    workers: [{
      config: {
        name: "retention-tests", compatibilityDate: "2026-09-24",
        manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default { fetch() { return new Response(null); } }" } } },
        env: { DB: { type: "d1", id: "retention-db" }, RECORDINGS: { type: "r2", name: "retention-bucket" } },
      },
    }],
  });
  t.after(() => runtime.dispose());
  const DB = await runtime.getD1Database("DB");
  const RECORDINGS = await runtime.getR2Bucket("RECORDINGS");
  const migrations = new URL("../../migrations/", import.meta.url);
  for (const name of (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort()) {
    const statements = unstable_splitSqlQuery(await readFile(new URL(name, migrations), "utf8"));
    await DB.batch(statements.map((statement) => DB.prepare(statement)));
  }
  await DB.batch([
    DB.prepare("INSERT INTO employees (id, name, created_at) VALUES ('emp', 'Synthetic', ?)").bind(days(90)),
    DB.prepare("INSERT INTO devices (id, employee_id, token_hash, created_at) VALUES ('dev', 'emp', 'synthetic-hash', ?)").bind(days(90)),
  ]);
  let sequence = 0;
  async function add({ recordedAt, createdAt = days(1), status = "complete", object = true }) {
    sequence++;
    const key = `calls/${sequence}.m4a`;
    await DB.prepare(`INSERT INTO calls (id, employee_id, device_id, fingerprint, display_name, recorded_at, match_status,
      object_key, content_type, expected_bytes, actual_bytes, upload_status, created_at)
      VALUES (?, 'emp', 'dev', ?, 'Synthetic', ?, 'unmatched', ?, 'audio/mp4', 4, 4, ?, ?)`)
      .bind(`call_${sequence}`, sequence.toString(16).padStart(64, "0"), recordedAt ?? null, key, status, createdAt).run();
    if (object) await RECORDINGS.put(key, new Uint8Array([1, 2, 3, 4]));
    return { id: `call_${sequence}`, key };
  }
  const status = async (id) => (await DB.prepare("SELECT upload_status, deleted_at FROM calls WHERE id = ?").bind(id).first());
  const exists = async (key) => (await RECORDINGS.head(key)) !== null;
  const env = (RECORDING_RETENTION_DAYS) => ({ DB, RECORDINGS, RECORDING_RETENTION_DAYS });
  return { DB, RECORDINGS, add, status, exists, env };
}

test("only an explicit positive whole number of days enables the job", () => {
  for (const value of [undefined, "", " ", "0", "-5", "abc", "30.5", "3 0", "99999"]) {
    assert.equal(retentionDays({ RECORDING_RETENTION_DAYS: value }), null, String(value));
  }
  assert.equal(retentionDays({ RECORDING_RETENTION_DAYS: " 30 " }), 30);
});

test("disabled job deletes nothing even when recordings are ancient", async (t) => {
  const f = await fixture(t);
  const old = await f.add({ recordedAt: days(400) });
  assert.deepEqual(await purgeExpiredRecordings(f.env(undefined), { now }), { status: "disabled" });
  assert.deepEqual(await purgeExpiredRecordings(f.env("0"), { now }), { status: "disabled" });
  assert.equal((await f.status(old.id)).upload_status, "complete");
  assert.ok(await f.exists(old.key));
});

test("expired audio is removed and tombstoned; recent, boundary, pending and call logs are kept", async (t) => {
  const f = await fixture(t);
  const expired = await f.add({ recordedAt: days(31) });
  const fallback = await f.add({ recordedAt: null, createdAt: days(45) }); // age falls back to receipt time
  const backfilled = await f.add({ recordedAt: days(120), createdAt: days(0) }); // uploaded today, recorded long ago
  const boundary = await f.add({ recordedAt: days(30) }); // exactly at the cutoff is kept
  const recent = await f.add({ recordedAt: days(2) });
  const recentByReceipt = await f.add({ recordedAt: null, createdAt: days(3) });
  const pending = await f.add({ recordedAt: days(60), status: "pending", object: false });
  const already = await f.add({ recordedAt: days(60), status: "deleted", object: false });
  await f.DB.prepare(`INSERT INTO call_logs (id, device_id, employee_id, fingerprint, started_at, duration_seconds, call_type, created_at)
    VALUES ('log_old', 'dev', 'emp', ?, ?, 10, 'incoming', ?)`).bind("a".repeat(64), days(400), days(400)).run();

  const dry = await purgeExpiredRecordings(f.env("30"), { now, dryRun: true });
  assert.equal(dry.expired, 3);
  assert.ok(await f.exists(expired.key), "a dry run deletes nothing");

  const result = await purgeExpiredRecordings(f.env("30"), { now });
  assert.equal(result.status, "done");
  assert.equal(result.deleted, 3);
  assert.equal(result.remaining, false);
  for (const gone of [expired, fallback, backfilled]) {
    const row = await f.status(gone.id);
    assert.equal(row.upload_status, "deleted");
    assert.ok(row.deleted_at);
    assert.equal(await f.exists(gone.key), false);
  }
  for (const kept of [boundary, recent, recentByReceipt]) {
    assert.equal((await f.status(kept.id)).upload_status, "complete");
    assert.ok(await f.exists(kept.key));
  }
  assert.equal((await f.status(pending.id)).upload_status, "pending");
  assert.equal((await f.status(already.id)).upload_status, "deleted");
  assert.equal((await f.DB.prepare("SELECT count(*) n FROM call_logs").first()).n, 1, "call logs have no TTL");

  const again = await purgeExpiredRecordings(f.env("30"), { now });
  assert.equal(again.deleted, 0, "a second run is a no-op");
});

test("a large backlog is drained in capped runs without losing any row", async (t) => {
  const f = await fixture(t);
  const made = [];
  for (let index = 0; index < 125; index++) made.push(await f.add({ recordedAt: days(40) }));
  const first = await purgeExpiredRecordings(f.env("30"), { now, batchSize: 50, maxBatches: 2 });
  assert.equal(first.deleted, 100);
  assert.equal(first.remaining, true);
  const second = await purgeExpiredRecordings(f.env("30"), { now, batchSize: 50, maxBatches: 2 });
  assert.equal(second.deleted, 25);
  assert.equal(second.remaining, false);
  assert.equal((await f.DB.prepare("SELECT count(*) n FROM calls WHERE upload_status = 'complete'").first()).n, 0);
  for (const call of made) assert.equal(await f.exists(call.key), false);
});

test("an object already missing from R2 still tombstones the row", async (t) => {
  const f = await fixture(t);
  const missing = await f.add({ recordedAt: days(40), object: false });
  const result = await purgeExpiredRecordings(f.env("30"), { now });
  assert.equal(result.deleted, 1);
  assert.equal((await f.status(missing.id)).upload_status, "deleted");
});

test("an R2 failure leaves rows complete so the next run retries them", async (t) => {
  const f = await fixture(t);
  const victim = await f.add({ recordedAt: days(40) });
  const failing = { delete: async () => { throw new Error("private-storage-detail"); } };
  await assert.rejects(purgeExpiredRecordings({ DB: f.DB, RECORDINGS: failing, RECORDING_RETENTION_DAYS: "30" }, { now }));
  assert.equal((await f.status(victim.id)).upload_status, "complete");
  assert.ok(await f.exists(victim.key));
  assert.equal((await purgeExpiredRecordings(f.env("30"), { now })).deleted, 1);
});

test("job cost does not grow with the number of recordings already deleted", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 400; index++) await f.add({ recordedAt: days(100), status: "deleted", object: false });
  const expired = [];
  for (let index = 0; index < 5; index++) expired.push(await f.add({ recordedAt: days(40) }));
  let rowsRead = 0;
  const counted = {
    prepare: (sql) => {
      const statement = f.DB.prepare(sql);
      const wrap = (bound) => ({
        bind: (...values) => wrap(bound.bind(...values)),
        all: async () => { const result = await bound.all(); rowsRead += result.meta.rows_read; return result; },
        run: async () => { const result = await bound.run(); rowsRead += result.meta.rows_read; return result; },
      });
      return wrap(statement);
    },
  };
  const result = await purgeExpiredRecordings({ ...f.env("30"), DB: counted }, { now });
  assert.equal(result.deleted, 5);
  for (const call of expired) assert.equal((await f.status(call.id)).upload_status, "deleted");
  assert.ok(rowsRead < 100, `read ${rowsRead} rows to delete 5 recordings among 400 tombstones`);
});
