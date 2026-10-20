import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { createIdentityRepository } = await loadModule("./identity.ts");
const tokenSecret = "synthetic-retention-token-secret-not-for-deployment";
const day = 86_400_000;

async function fixture(t, RECORDING_RETENTION_DAYS) {
  const DB = await createDatabase(t);
  const identity = createIdentityRepository(DB, tokenSecret);
  const employee = await identity.createEmployee({ name: "Retention employee" });
  const invite = await identity.createInvitation(employee.id, new Date(Date.now() + day).toISOString());
  const enrolled = await identity.redeemInvitation(invite.invitationCode, { model: "Synthetic retention device" });
  const app = createApp();
  const env = { DB, TOKEN_HASH_SECRET: tokenSecret, ENVIRONMENT: "production", MAX_RECORDING_BYTES: "1048576", RECORDING_RETENTION_DAYS };
  let n = 0;
  const prepare = (recordedAt) => app.request("http://127.0.0.1/v1/device/uploads/prepare", {
    method: "POST",
    headers: { Authorization: `Bearer ${enrolled.deviceToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fingerprint: (++n).toString(16).padStart(64, "0"),
      file: { displayName: `rec${n}.m4a`, contentType: "audio/mp4", expectedBytes: 1000, durationSeconds: 30, ...(recordedAt ? { recordedAt } : {}) },
      call: { matchStatus: "media_metadata" },
    }),
  }, env);
  const rows = async () => (await DB.prepare("SELECT count(*) n FROM calls").first()).n;
  return { prepare, rows, DB, setN: (value) => { n = value; } };
}

const ago = (days) => new Date(Date.now() - days * day).toISOString();

test("with retention on, audio older than the period is refused before any row exists; newer or undated audio is accepted", async (t) => {
  const f = await fixture(t, "30");
  const old = await f.prepare(ago(31));
  assert.equal(old.status, 409);
  assert.equal(await f.rows(), 0, "nothing is stored for refused audio");
  assert.equal((await f.prepare(ago(29))).status, 200);
  assert.equal((await f.prepare()).status, 200, "unknown recording time is treated as new");
  assert.equal(await f.rows(), 2);
  assert.equal((await f.prepare(ago(400))).status, 409);
});

test("without retention configured, old audio is accepted as before", async (t) => {
  for (const value of [undefined, "", "0", "abc"]) {
    const f = await fixture(t, value);
    assert.equal((await f.prepare(ago(400))).status, 200, String(value));
  }
});

test("a repeated prepare of audio that has since aged out is also refused", async (t) => {
  const f = await fixture(t, "30");
  const first = await f.prepare(ago(10));
  assert.equal(first.status, 200);
  // Same fingerprint again, now reported as older than the period (for example after a retention change).
  f.setN(0);
  assert.equal((await f.prepare(ago(40))).status, 409);
});
