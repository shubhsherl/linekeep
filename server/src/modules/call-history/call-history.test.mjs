import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";

import { createDatabase, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { createIdentityRepository } = await loadModule("./identity.ts");
const { createCallRepository } = await loadModule("./calls.ts");
const adminSecret = "synthetic-history-admin-secret-not-for-deployment";
const tokenSecret = "synthetic-history-token-secret-not-for-deployment";
const start = "2026-09-24T12:00:00.000Z";

function entry(index, extra = {}) {
  return {
    fingerprint: index.toString(16).padStart(64, "0"),
    startedAt: "2026-09-24T11:00:00Z",
    durationSeconds: 0,
    callType: "missed",
    ...extra,
  };
}

async function fixture(t, throughMigration) {
  const DB = await createDatabase(t, throughMigration);
  let now = new Date(start);
  const identity = createIdentityRepository(DB, tokenSecret, () => now);
  const employee = await identity.createEmployee({ name: "History employee" });
  async function register(employeeId = employee.id) {
    const invite = await identity.createInvitation(employeeId, "2026-09-25T00:00:00Z");
    return identity.redeemInvitation(invite.invitationCode, { model: "Synthetic history device" });
  }
  const enrollment = await register();
  const env = {
    DB, TOKEN_HASH_SECRET: tokenSecret, LOCAL_ADMIN_SECRET: adminSecret,
    ENVIRONMENT: "development",
  };
  const app = createApp();
  const request = (path, options = {}, overrides = {}) => app.request(
    new URL(path, "http://127.0.0.1"), options, { ...env, ...overrides },
  );
  const post = (entries, enrolled = enrollment, extra = {}, overrides = {}) => request(
    "/v1/device/call-logs/batch",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${enrolled.deviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: enrolled.device.id, entries, ...extra }),
    }, overrides,
  );
  const list = (query = "") => request(`/v1/admin/call-logs${query}`, {
    headers: { Authorization: `Bearer ${adminSecret}` },
  });
  return { DB, identity, employee, enrollment, register, request, post, list,
    setTime: (value) => { now = new Date(value); } };
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.equal(body.requestId, response.headers.get("X-Request-Id"));
  return body;
}

test("fifty maximum-length Unicode entries sync without audio; larger or invalid batches write nothing", async (t) => {
  const f = await fixture(t);
  const entries = Array.from({ length: 50 }, (_, index) => entry(index, {
    remoteNumber: "界".repeat(80), durationSeconds: 604800, callType: "answered_externally",
    callerName: "\u0001".repeat(256), localNumber: "\u0001".repeat(80),
    simLabel: "\u0001".repeat(120), phoneAccountId: "\u0001".repeat(256),
  }));
  assert.ok(Buffer.byteLength(JSON.stringify({ deviceId: f.enrollment.device.id, entries })) > 131072);
  const response = await f.post(entries);
  assert.equal(response.status, 200);
  const { accepted } = await response.json();
  assert.deepEqual(accepted.map((row) => row.fingerprint), entries.map((row) => row.fingerprint));
  const page = await (await f.list()).json();
  assert.equal(page.items.length, 50);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(new Set(page.items.map((row) => row.id)), new Set(accepted.map((row) => row.id)));
  await expectError(await f.post([...entries, entry(100)]), 400, "INVALID_REQUEST");
  await expectError(await f.post([entry(101), entry(102, { durationSeconds: 0.5 })]), 400, "INVALID_REQUEST");
  await expectError(await f.post([]), 400, "INVALID_REQUEST");
  for (const [field, length] of [["callerName", 256], ["localNumber", 80], ["simLabel", 120], ["phoneAccountId", 256]]) {
    await expectError(await f.post([entry(200), entry(201, { [field]: "x".repeat(length + 1) })]), 400, "INVALID_REQUEST");
  }
  await expectError(await f.request("/v1/device/call-logs/batch", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(262144) }),
  }), 413, "FILE_TOO_LARGE");
  assert.equal((await (await f.list("?limit=100")).json()).items.length, 50);
  // Only the bounded history endpoint receives a larger JSON allowance.
  await expectError(await f.request("/v1/device/heartbeat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ padding: "a".repeat(17000) }),
  }), 413, "FILE_TOO_LARGE");
});

test("duplicates and replays refresh metadata with stable IDs and device-isolated fingerprints", async (t) => {
  const f = await fixture(t);
  const response = await f.post([
    entry(1), entry(1, { durationSeconds: 15, callType: "incoming", remoteNumber: "+15550123" }),
  ]);
  assert.equal(response.status, 200);
  const { accepted } = await response.json();
  assert.equal(accepted.length, 2);
  assert.equal(accepted[0].id, accepted[1].id);
  const original = (await (await f.list()).json()).items[0];
  assert.equal(original.durationSeconds, 15);
  const replay = await f.post([entry(1, { startedAt: "2026-09-24T11:00:00.000Z", durationSeconds: 20, callType: "outgoing" })]);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).accepted[0].id, original.id);
  const updated = (await (await f.list()).json()).items[0];
  assert.equal(updated.durationSeconds, 20);
  assert.equal(updated.callType, "outgoing");
  assert.equal(Object.hasOwn(updated, "remoteNumber"), false);
  assert.equal(updated.createdAt, original.createdAt);
  const other = await f.register();
  const second = await f.post([entry(1)], other);
  assert.equal(second.status, 200);
  assert.notEqual((await second.json()).accepted[0].id, original.id);
  assert.equal((await (await f.list()).json()).items.length, 2);
});

test("timestamp conflicts roll back earlier inserts and updates, including duplicate conflicts within a batch", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post([entry(1)])).status, 200);
  await expectError(await f.post([
    entry(1, { durationSeconds: 30 }), entry(2),
    entry(1, { startedAt: "2026-09-24T11:00:01Z" }),
  ]), 409, "INVALID_STATE");
  const page = await (await f.list()).json();
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].durationSeconds, 0);
  await expectError(await f.post([
    entry(3), entry(3, { startedAt: "2026-09-24T11:00:02Z" }),
  ]), 409, "INVALID_STATE");
  assert.equal((await (await f.list()).json()).items.length, 1);
});

test("pre-enrollment, offline and handover-boundary entries follow assignment history; replays retain the first owner", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post([entry(1, { startedAt: "2026-09-24T13:30:00Z" })])).status, 200);
  const original = (await (await f.list()).json()).items[0];
  const next = await f.identity.createEmployee({ name: "Next owner" });
  f.setTime("2026-09-24T13:00:00Z");
  await f.identity.reassignDevice(f.enrollment.device.id, next.id);
  const response = await f.post([
    entry(1, { startedAt: "2026-09-24T13:30:00Z", durationSeconds: 10 }),
    entry(2, { startedAt: "2026-09-23T10:00:00Z" }),
    entry(3, { startedAt: "2026-09-24T12:59:59.999Z" }),
    entry(4, { startedAt: "2026-09-24T13:00:00Z" }),
  ]);
  assert.equal(response.status, 200);
  const ids = (await response.json()).accepted.map((row) => row.id);
  const items = (await (await f.list()).json()).items;
  const byId = new Map(items.map((row) => [row.id, row]));
  assert.equal(ids[0], original.id);
  for (const id of ids.slice(0, 3)) assert.equal(byId.get(id).employee.id, f.employee.id);
  assert.equal(byId.get(ids[3]).employee.id, next.id);
  assert.equal(byId.get(original.id).durationSeconds, 10);
});

test("revocation after bearer authentication is authoritative at persistence and does not affect another device", async (t) => {
  const f = await fixture(t);
  const other = await f.register();
  const racedDB = {
    prepare: f.DB.prepare.bind(f.DB),
    batch: async (statements) => {
      await f.identity.revokeDevice(f.enrollment.device.id);
      return f.DB.batch(statements);
    },
  };
  await expectError(await f.post([entry(1), entry(2)], f.enrollment, {}, { DB: racedDB }), 401, "UNAUTHORIZED");
  assert.equal((await (await f.list()).json()).items.length, 0);
  assert.equal((await f.post([entry(1)], other)).status, 200);
  await expectError(await f.post([entry(3)]), 401, "UNAUTHORIZED");
});

test("inactive historical or current employees abort the whole batch at persistence", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post([entry(2)])).status, 200);
  const original = (await (await f.list()).json()).items;
  const next = await f.identity.createEmployee({ name: "Current owner" });
  f.setTime("2026-09-24T13:00:00Z");
  await f.identity.reassignDevice(f.enrollment.device.id, next.id);
  const racedDB = {
    prepare: f.DB.prepare.bind(f.DB),
    batch: async (statements) => {
      await f.DB.prepare("UPDATE employees SET active = 0 WHERE id = ?").bind(f.employee.id).run();
      return f.DB.batch(statements);
    },
  };
  await expectError(await f.post([
    entry(1, { startedAt: "2026-09-24T14:00:00Z" }), entry(2, { durationSeconds: 30 }),
  ], f.enrollment, {}, { DB: racedDB }), 401, "UNAUTHORIZED");
  assert.deepEqual((await (await f.list()).json()).items, original);
  await f.DB.prepare("UPDATE employees SET active = 1 WHERE id = ?").bind(f.employee.id).run();
  const currentRace = {
    prepare: f.DB.prepare.bind(f.DB),
    batch: async (statements) => {
      await f.DB.prepare("UPDATE employees SET active = 0 WHERE id = ?").bind(next.id).run();
      return f.DB.batch(statements);
    },
  };
  await expectError(await f.post([entry(3)], f.enrollment, {}, { DB: currentRace }), 401, "UNAUTHORIZED");
  assert.deepEqual((await (await f.list()).json()).items, original);
});

test("history administration is guarded, rejects spoofed identity and invalid filters, and never exposes credentials", async (t) => {
  const f = await fixture(t);
  await expectError(await f.request("/v1/admin/call-logs"), 401, "UNAUTHORIZED");
  await expectError(await f.request("/v1/admin/call-logs", {
    headers: { Authorization: `Bearer ${f.enrollment.deviceToken}` },
  }), 401, "UNAUTHORIZED");
  await expectError(await f.post([entry(1)], f.enrollment, { deviceId: "another-device" }), 401, "UNAUTHORIZED");
  await expectError(await f.post([entry(1, { employeeId: "spoofed-owner" })]), 400, "INVALID_REQUEST");
  for (const query of ["?callType=complete", "?limit=101", "?limit=1&limit=2", "?cursor=bad!", "?from=2026-09-25T00:00:00Z&to=2026-09-24T00:00:00Z"]) {
    await expectError(await f.list(query), 400, "INVALID_REQUEST");
  }
  assert.equal((await (await f.list()).json()).items.length, 0);
  assert.equal((await f.post([entry(1)])).status, 200);
  const body = await (await f.list()).text();
  assert.equal(body.includes(f.enrollment.deviceToken), false);
  assert.equal(body.includes("token_hash"), false);
  assert.equal(body.includes("fingerprint"), false);
});

test("literal number filters and start-time/ID pagination preserve all tied entries without audio", async (t) => {
  const f = await fixture(t);
  const response = await f.post([
    entry(1, { remoteNumber: "literal%_\\number" }),
    entry(2, { remoteNumber: "literalXXnumber" }),
    entry(3, { startedAt: "2026-09-24T10:00:00Z", callType: "blocked" }),
  ]);
  assert.equal(response.status, 200);
  const accepted = (await response.json()).accepted;
  for (const literal of ["%", "_", "\\"]) {
    const page = await (await f.list(`?number=${encodeURIComponent(literal)}`)).json();
    assert.deepEqual(page.items.map((row) => row.id), [accepted[0].id]);
  }
  const all = [];
  let cursor;
  do {
    const page = await (await f.list(`?limit=1${cursor ? `&cursor=${cursor}` : ""}`)).json();
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(all.map((row) => row.id), [
    ...accepted.slice(0, 2).map((row) => row.id).sort().reverse(), accepted[2].id,
  ]);
  const filtered = await (await f.list(`?employeeId=${f.employee.id}&callType=blocked&from=2026-09-24T10:00:00Z&to=2026-09-24T10:00:00Z`)).json();
  assert.deepEqual(filtered.items.map((row) => row.id), [accepted[2].id]);
});

async function recording(f, index, extra = {}, complete = true) {
  const repository = createCallRepository(f.DB, () => new Date(start));
  const pending = await repository.createPending({
    deviceId: f.enrollment.device.id, fingerprint: index.toString(16).padStart(64, "0"),
    displayName: "synthetic.m4a", contentType: "audio/mp4", expectedBytes: 4,
    recordedAt: "2026-09-24T11:00:00.500Z", durationSeconds: 20, matchStatus: "media_metadata",
    ...extra,
  });
  return complete ? repository.complete(pending.id, pending.deviceId, { actualBytes: 4 }) : pending;
}

test("both stream arrival orders attach multiple recordings and retain the first historical line snapshot", async (t) => {
  const f = await fixture(t);
  const firstAudio = await recording(f, 1);
  assert.equal((await (await f.list()).json()).items[0].kind, "recording");
  const original = entry(1, {
    durationSeconds: 20, callType: "incoming", callerName: "Caller",
    localNumber: "+15550001", simLabel: "Work SIM", phoneAccountId: "account-one",
  });
  const accepted = (await (await f.post([original])).json()).accepted[0];
  const secondAudio = await recording(f, 2);
  const pendingAudio = await recording(f, 3, {}, false);
  await f.post([{ ...original, callerName: "Updated caller", localNumber: "+15559999", simLabel: "New SIM", phoneAccountId: "new-account" }]);
  const page = await (await f.list("?hasRecording=true&limit=1")).json();
  assert.equal(page.nextCursor, null);
  assert.equal(page.items[0].id, accepted.id);
  assert.equal(page.items[0].callerName, "Updated caller");
  assert.equal(page.items[0].localNumber, original.localNumber);
  assert.equal(page.items[0].simLabel, original.simLabel);
  assert.equal(page.items[0].phoneAccountId, original.phoneAccountId);
  assert.deepEqual(new Set(page.items[0].recordings.map((r) => r.id)), new Set([firstAudio.id, secondAudio.id, pendingAudio.id]));
  const frozen = await (await f.request("/v1/admin/calls", { headers: { Authorization: `Bearer ${adminSecret}` } })).json();
  assert.deepEqual(page.items[0].recordings, frozen.items);
});

test("ambiguity uses all history even outside filters/pages, and replay changes recompute associations", async (t) => {
  const f = await fixture(t);
  const audio = await recording(f, 1);
  const first = entry(1, { durationSeconds: 20, callType: "incoming", remoteNumber: "wanted" });
  const second = entry(2, { durationSeconds: 20, callType: "outgoing", remoteNumber: "other" });
  const accepted = (await (await f.post([first, second])).json()).accepted;
  const filtered = await (await f.list("?callType=incoming&number=wanted&limit=1")).json();
  assert.equal(filtered.items[0].id, accepted[0].id);
  assert.deepEqual(filtered.items[0].recordings, []);
  assert.deepEqual((await (await f.list("?hasRecording=true&callType=incoming")).json()).items, []);
  const all = [];
  let cursor;
  do {
    const page = await (await f.list(`?limit=1${cursor ? `&cursor=${cursor}` : ""}`)).json();
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(new Set(all.map((r) => r.id)), new Set([audio.id, ...accepted.map((r) => r.id)]));
  assert.equal(all.find((r) => r.id === audio.id).kind, "recording");
  await f.post([{ ...second, durationSeconds: 21 }]);
  const unique = await (await f.list("?hasRecording=true")).json();
  assert.deepEqual(unique.items.map((r) => r.id), [accepted[0].id]);
  assert.equal(unique.items[0].recordings[0].id, audio.id);
  await f.post([second]);
  assert.deepEqual((await (await f.list("?hasRecording=true")).json()).items.map((r) => r.id), [audio.id]);
});

test("unknown or conflicting metadata stays visible and complete-audio filtering excludes unavailable recordings", async (t) => {
  const f = await fixture(t);
  const historyId = (await (await f.post([entry(1, { durationSeconds: 20, callType: "incoming", remoteNumber: "known" })])).json()).accepted[0].id;
  const conflict = await recording(f, 1, { remoteNumber: "conflict" });
  const zero = await recording(f, 2, { durationSeconds: 0 });
  const unknown = await recording(f, 3, { recordedAt: undefined });
  const wrongSecond = await recording(f, 4, { recordedAt: "2026-09-24T11:00:01Z" });
  const pending = await recording(f, 5, { recordedAt: undefined }, false);
  const deleted = await recording(f, 6, { recordedAt: undefined });
  await createCallRepository(f.DB).markDeleted(deleted.id);
  const attached = await recording(f, 7, { remoteNumber: "known" });
  await createCallRepository(f.DB).markDeleted(attached.id);
  const page = await (await f.list("?hasRecording=true")).json();
  assert.deepEqual(new Set(page.items.map((r) => r.id)), new Set([conflict.id, zero.id, unknown.id, wrongSecond.id]));
  const sourceLess = page.items.find((r) => r.id === unknown.id);
  assert.equal(sourceLess.kind, "recording");
  assert.equal(Object.hasOwn(sourceLess, "startedAt"), false);
  for (const field of ["callType", "callerName", "localNumber", "phoneAccountId", "simLabel"]) {
    assert.equal(Object.hasOwn(sourceLess, field), false);
  }
  const all = (await (await f.list()).json()).items;
  assert.ok(all.some((r) => r.id === pending.id));
  assert.equal(all.some((r) => r.id === deleted.id), false);
  assert.deepEqual(all.find((row) => row.id === historyId).recordings, []);
  assert.deepEqual((await (await f.list("?callType=incoming&hasRecording=true")).json()).items, []);
});

test("association never crosses devices or employees even inside the same timestamp second", async (t) => {
  const f = await fixture(t);
  const otherDevice = await f.register();
  const candidate = entry(1, { durationSeconds: 20, callType: "incoming" });
  const firstId = (await (await f.post([candidate])).json()).accepted[0].id;
  await f.post([candidate], otherDevice);
  const ownAudio = await recording(f, 1);
  const otherAudio = await recording(f, 2, { deviceId: otherDevice.device.id });
  const sameEmployee = (await (await f.list("?hasRecording=true")).json()).items;
  assert.equal(sameEmployee.find((row) => row.id === firstId).recordings[0].id, ownAudio.id);
  assert.equal(sameEmployee.find((row) => row.deviceId === otherDevice.device.id).recordings[0].id, otherAudio.id);
  const nextEmployee = await f.identity.createEmployee({ name: "Next holder" });
  f.setTime("2026-09-24T12:00:01.500Z");
  await f.identity.reassignDevice(f.enrollment.device.id, nextEmployee.id);
  const historical = entry(3, { startedAt: "2026-09-24T12:00:01.100Z", durationSeconds: 20, callType: "outgoing" });
  const historyId = (await (await f.post([historical])).json()).accepted[0].id;
  const laterAudio = await recording(f, 3, { recordedAt: "2026-09-24T12:00:01.900Z" });
  const all = (await (await f.list()).json()).items;
  assert.deepEqual(all.find((row) => row.id === historyId).recordings, []);
  assert.equal(all.find((row) => row.id === laterAudio.id).kind, "recording");
  assert.equal(all.find((row) => row.id === laterAudio.id).employee.id, nextEmployee.id);
});

async function deleteHistory(f, id) {
  return f.request(`/v1/admin/call-logs/${id}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${adminSecret}` },
  });
}

test("deleted history acknowledges duplicate replay without changing its tombstone or resurrecting in the feed", async (t) => {
  const f = await fixture(t);
  const original = entry(1, {
    durationSeconds: 20, callType: "incoming", remoteNumber: "+15550001",
    callerName: "Original caller", localNumber: "+15550002", simLabel: "Work", phoneAccountId: "line-one",
  });
  const accepted = (await (await f.post([original])).json()).accepted[0];
  const deleted = await deleteHistory(f, accepted.id);
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), {
    requestId: deleted.headers.get("X-Request-Id"), callLogId: accepted.id, status: "deleted",
  });
  const tombstone = await f.DB.prepare("SELECT * FROM call_logs WHERE id = ?").bind(accepted.id).first();
  assert.ok(tombstone.deleted_at);
  const replay = await f.post([
    { ...original, durationSeconds: 0, callType: "missed", remoteNumber: "changed", callerName: "Changed caller" },
    entry(2), original,
  ]);
  assert.equal(replay.status, 200);
  const replayed = (await replay.json()).accepted;
  assert.deepEqual(replayed[0], accepted);
  assert.deepEqual(replayed[2], accepted);
  assert.deepEqual(await f.DB.prepare("SELECT * FROM call_logs WHERE id = ?").bind(accepted.id).first(), tombstone);
  assert.deepEqual((await (await f.list("?limit=1")).json()).items.map((row) => row.id), [replayed[1].id]);
  assert.equal((await (await f.list("?limit=1")).json()).nextCursor, null);
  assert.equal((await deleteHistory(f, accepted.id)).status, 200);
  assert.deepEqual(await f.DB.prepare("SELECT * FROM call_logs WHERE id = ?").bind(accepted.id).first(), tombstone);
});

test("only an administrator can delete history, including after device revocation and employee deactivation", async (t) => {
  const f = await fixture(t);
  const id = (await (await f.post([entry(1)])).json()).accepted[0].id;
  const path = `/v1/admin/call-logs/${id}`;
  await expectError(await f.request(path, { method: "DELETE" }), 401, "UNAUTHORIZED");
  await expectError(await f.request(path, {
    method: "DELETE", headers: { Authorization: `Bearer ${f.enrollment.deviceToken}` },
  }), 401, "UNAUTHORIZED");
  await expectError(await f.request(path, {
    method: "DELETE", headers: { Authorization: `Bearer ${adminSecret}` },
  }, { ENVIRONMENT: "production" }), 401, "UNAUTHORIZED");
  const session = await f.request("/admin/session", {
    method: "POST", headers: { Origin: "http://127.0.0.1", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret: adminSecret }),
  });
  assert.equal(session.status, 303);
  const cookie = session.headers.get("Set-Cookie").split(";")[0];
  await expectError(await f.request(path, {
    method: "DELETE", headers: { Cookie: cookie, Origin: "https://attacker.example" },
  }), 401, "UNAUTHORIZED");
  assert.deepEqual((await (await f.list()).json()).items.map((row) => row.id), [id]);
  await f.identity.revokeDevice(f.enrollment.device.id);
  await f.DB.prepare("UPDATE employees SET active = 0 WHERE id = ?").bind(f.employee.id).run();
  const deleted = await f.request(path, {
    method: "DELETE", headers: { Cookie: cookie, Origin: "http://127.0.0.1" },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual((await (await f.list()).json()).items, []);
  assert.equal((await deleteHistory(f, id)).status, 200);
  assert.equal((await deleteHistory(f, "call_missing")).status, 200);
  await expectError(await f.post([entry(1)]), 401, "UNAUTHORIZED");
});

test("recording and history deletion are independent and preserve or invalidate actual audio capabilities respectively", async (t) => {
  const f = await fixture(t);
  const runtime = new Miniflare({
    workers: [{
      config: {
        name: "history-deletion-audio-tests", compatibilityDate: "2026-09-24",
        manifest: {
          mainModule: "index.js",
          modules: { "index.js": { type: "esm", contents: "export default { fetch() { return new Response(null, { status: 404 }); } }" } },
        },
        env: { RECORDINGS: { type: "r2", name: "history-deletion-recordings" } },
      },
    }],
  });
  t.after(() => runtime.dispose());
  const bucket = await runtime.getR2Bucket("RECORDINGS");
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const request = (path, method = "GET") => f.request(path, {
    method, headers: { Authorization: `Bearer ${adminSecret}` },
  }, { RECORDINGS: bucket });
  const id = (await (await f.post([entry(1, { durationSeconds: 20, callType: "incoming" })])).json()).accepted[0].id;
  const first = await recording(f, 1);
  const kept = await recording(f, 2);
  for (const call of [first, kept]) await bucket.put(call.objectKey, bytes, { httpMetadata: { contentType: "audio/mp4" } });
  const firstLink = await (await request(`/v1/admin/calls/${first.id}/playback`, "POST")).json();
  const keptLink = await (await request(`/v1/admin/calls/${kept.id}/playback`, "POST")).json();
  assert.deepEqual(new Uint8Array(await (await request(firstLink.url)).arrayBuffer()), bytes);
  assert.equal((await request(`/v1/admin/calls/${first.id}`, "DELETE")).status, 200);
  assert.equal((await request(`/v1/admin/calls/${first.id}`, "DELETE")).status, 200);
  assert.equal(await bucket.head(first.objectKey), null);
  assert.equal((await request(firstLink.url)).status, 404);
  const afterAudio = (await (await f.list()).json()).items;
  assert.deepEqual(afterAudio.map((row) => row.id), [id]);
  assert.deepEqual(afterAudio[0].recordings.map((row) => row.id), [kept.id]);
  assert.equal((await deleteHistory(f, id)).status, 200);
  const afterHistory = (await (await f.list("?hasRecording=true")).json()).items;
  assert.deepEqual(afterHistory.map((row) => [row.kind, row.id]), [["recording", kept.id]]);
  assert.deepEqual(new Uint8Array(await (await request(keptLink.url)).arrayBuffer()), bytes);
  const lateAudio = await recording(f, 3);
  assert.deepEqual(new Set((await (await f.list()).json()).items.map((row) => `${row.kind}:${row.id}`)),
    new Set([`recording:${kept.id}`, `recording:${lateAudio.id}`]));
  assert.equal((await request(`/v1/admin/calls/${kept.id}`, "DELETE")).status, 200);
  assert.equal((await request(keptLink.url)).status, 404);
  assert.deepEqual((await (await f.list()).json()).items.map((row) => row.id), [lateAudio.id]);
  const legacy = await (await request("/v1/admin/calls?status=deleted")).json();
  assert.deepEqual(new Set(legacy.items.map((row) => row.id)), new Set([first.id, kept.id]));
});

test("deleted candidates retain full-data ambiguity through live replay, late audio and metadata reassociation", async (t) => {
  const f = await fixture(t);
  const first = entry(1, { durationSeconds: 20, callType: "incoming", remoteNumber: "first" });
  const second = entry(2, { durationSeconds: 20, callType: "outgoing", remoteNumber: "second" });
  const accepted = (await (await f.post([first, second])).json()).accepted;
  const audio = await recording(f, 1);
  assert.equal((await deleteHistory(f, accepted[0].id)).status, 200);
  await f.post([{ ...first, durationSeconds: 0, callType: "missed" }, second]);
  const laterAudio = await recording(f, 2);
  await f.DB.prepare("UPDATE calls SET recorded_at = ? WHERE id = ?")
    .bind("2026-09-24T11:00:00.900Z", audio.id).run();
  const filtered = (await (await f.list("?callType=outgoing&limit=1")).json()).items;
  assert.deepEqual(filtered.map((row) => row.id), [accepted[1].id]);
  assert.deepEqual(filtered[0].recordings, []);
  assert.deepEqual((await (await f.list("?callType=outgoing&hasRecording=true")).json()).items, []);
  const playable = (await (await f.list("?hasRecording=true")).json()).items;
  assert.deepEqual(new Set(playable.map((row) => `${row.kind}:${row.id}`)),
    new Set([`recording:${audio.id}`, `recording:${laterAudio.id}`]));
  const third = entry(3, { durationSeconds: 20, callType: "incoming" });
  const inserted = (await (await f.post([third])).json()).accepted[0];
  assert.deepEqual((await (await f.list("?hasRecording=true")).json()).items.map((row) => row.id),
    playable.map((row) => row.id));
  assert.deepEqual((await (await f.list("?callType=incoming")).json()).items.map((row) => row.id), [inserted.id]);
});

test("Samsung filename start and media end attach the real-world 96-second and 180-second timing patterns", async (t) => {
  const f = await fixture(t);
  // Anonymized development metadata: Android call time includes ringing; the
  // Samsung filename starts 7–8 seconds later and the media date marks the end.
  const cases = [
    { startedAt: "2026-09-27T09:10:25.312Z", displayName: "Call Casey#_260927_144033.m4a", recordedAt: "2026-09-27T09:12:09.000Z", durationSeconds: 96 },
    { startedAt: "2026-09-27T06:37:34.207Z", displayName: "Call Casey#_260927_120741.m4a", recordedAt: "2026-09-27T06:40:41.000Z", durationSeconds: 180 },
  ];
  for (const [index, sample] of cases.entries()) {
    const history = entry(index + 1, {
      startedAt: sample.startedAt, durationSeconds: sample.durationSeconds,
      callType: "incoming", callerName: "Casey#", remoteNumber: "+15550123456",
    });
    // Exercise both arrival orders with the same source-time semantics.
    let audio;
    if (index === 0) audio = await recording(f, index + 1, sample);
    const response = await f.post([history]);
    assert.equal(response.status, 200);
    const id = (await response.json()).accepted[0].id;
    if (index === 1) audio = await recording(f, index + 1, sample);
    const page = await (await f.list("?hasRecording=true")).json();
    assert.equal(page.items.find((row) => row.id === id)?.recordings[0]?.id, audio.id);
    assert.equal(page.items.some((row) => row.kind === "recording" && row.id === audio.id), false);
  }
});

test("Samsung numeric identity tolerates formatting and two seconds of duration rounding, not country-code guesses", async (t) => {
  const f = await fixture(t);
  const history = entry(1, {
    startedAt: "2026-09-27T09:10:25.312Z", durationSeconds: 98,
    callType: "outgoing", remoteNumber: "+1 (555) 012-3456",
  });
  const id = (await (await f.post([history])).json()).accepted[0].id;
  const audio = await recording(f, 1, {
    displayName: "Call +15550123456_260927_144033.m4a",
    recordedAt: "2026-09-27T09:10:33Z", durationSeconds: 96, remoteNumber: "+15550123456",
  });
  assert.equal((await (await f.list("?hasRecording=true")).json()).items[0].id, id);
  await f.post([{ ...history, durationSeconds: 99 }]);
  assert.equal((await (await f.list("?hasRecording=true")).json()).items[0].id, audio.id);
  await f.post([history]);
  await f.DB.prepare("UPDATE calls SET display_name = ? WHERE id = ?")
    .bind("Call 5550123456_260927_144033.m4a", audio.id).run();
  assert.equal((await (await f.list("?hasRecording=true")).json()).items[0].id, audio.id);
});

test("Samsung evidence rejects wrong identities, directions, dates, offsets, missing source times and excessive ringing gaps", async (t) => {
  const f = await fixture(t);
  const id = (await (await f.post([entry(1, {
    startedAt: "2026-09-27T09:10:25.312Z", durationSeconds: 96,
    callType: "incoming", callerName: "Casey#", remoteNumber: "+15550123456",
  })])).json()).accepted[0].id;
  const base = {
    displayName: "Call Casey#_260927_144033.m4a",
    recordedAt: "2026-09-27T09:12:09Z", durationSeconds: 96,
  };
  const rejected = [
    { displayName: "Call Different name_260927_144033.m4a" },
    { remoteNumber: "+15550999999" },
    { direction: "outgoing" },
    { displayName: "Call Casey#_260230_144033.m4a" },
    { displayName: "Call Casey#_260927_144133.m4a" },
    { recordedAt: undefined },
    { durationSeconds: undefined },
    { displayName: "Call Casey#_260927_144056.m4a", recordedAt: "2026-09-27T09:12:32Z" },
  ];
  for (const [index, extra] of rejected.entries()) {
    await recording(f, index + 1, { ...base, ...extra });
  }
  const page = (await (await f.list())).json();
  assert.deepEqual((await page).items.find((row) => row.id === id).recordings, []);
  assert.equal((await (await f.list("?hasRecording=true")).json()).items.every((row) => row.kind === "recording"), true);
});

test("Samsung ambiguity is not resolved by closest time, filtering or deletion, and caller-name updates recompute links", async (t) => {
  const f = await fixture(t);
  const first = entry(1, {
    startedAt: "2026-09-27T09:10:25.312Z", durationSeconds: 96,
    callType: "incoming", callerName: "Casey#", remoteNumber: "+15550123456",
  });
  const id = (await (await f.post([first])).json()).accepted[0].id;
  const metadata = {
    displayName: "Call Casey#_260927_144033.m4a", recordedAt: "2026-09-27T09:12:09Z", durationSeconds: 96,
  };
  const audio = await recording(f, 1, metadata);
  assert.equal((await (await f.list("?hasRecording=true")).json()).items[0].id, id);
  await f.post([{ ...first, callerName: "Different caller" }]);
  assert.equal((await (await f.list("?hasRecording=true")).json()).items[0].id, audio.id);
  await f.post([first]);
  const second = entry(2, { ...first, fingerprint: entry(2).fingerprint, startedAt: "2026-09-27T09:10:24Z", callType: "outgoing" });
  await f.post([second]);
  assert.deepEqual((await (await f.list("?callType=incoming&hasRecording=true&limit=1")).json()).items, []);
  assert.equal((await deleteHistory(f, id)).status, 200);
  await f.post([first, second]);
  const later = await recording(f, 2, metadata);
  assert.deepEqual(new Set((await (await f.list("?hasRecording=true")).json()).items.map((row) => `${row.kind}:${row.id}`)),
    new Set([`recording:${audio.id}`, `recording:${later.id}`]));
});

test("Samsung inferred intervals do not cross devices or employee handover boundaries", async (t) => {
  const f = await fixture(t);
  const original = entry(1, {
    startedAt: "2026-09-27T09:10:25.312Z", durationSeconds: 96, callType: "incoming", callerName: "Casey#",
  });
  const id = (await (await f.post([original])).json()).accepted[0].id;
  const metadata = {
    displayName: "Call Casey#_260927_144033.m4a", recordedAt: "2026-09-27T09:12:09Z", durationSeconds: 96,
  };
  const other = await f.register();
  const otherAudio = await recording(f, 1, { ...metadata, deviceId: other.device.id });
  const next = await f.identity.createEmployee({ name: "Next synthetic employee" });
  f.setTime("2026-09-27T09:11:00Z");
  await f.identity.reassignDevice(f.enrollment.device.id, next.id);
  const laterOwnerAudio = await recording(f, 2, metadata);
  const page = (await (await f.list())).json();
  assert.deepEqual((await page).items.find((row) => row.id === id).recordings, []);
  assert.deepEqual(new Set((await (await f.list("?hasRecording=true")).json()).items.map((row) => `${row.kind}:${row.id}`)),
    new Set([`recording:${otherAudio.id}`, `recording:${laterOwnerAudio.id}`]));
});

test("migration backfills existing Samsung metadata without changing source evidence or restoring deleted history", async (t) => {
  const f = await fixture(t, "0006_call_log_deletion.sql");
  const original = entry(1, {
    startedAt: "2026-09-27T09:10:25.312Z", durationSeconds: 96, callType: "incoming", callerName: "Casey#",
  });
  const deleted = entry(2, {
    startedAt: "2026-09-27T06:37:34.207Z", durationSeconds: 180, callType: "incoming", callerName: "Casey#",
  });
  const accepted = (await (await f.post([original, deleted])).json()).accepted;
  const audio = await recording(f, 1, {
    displayName: "Call Casey#_260927_144033.m4a", recordedAt: "2026-09-27T09:12:09Z", durationSeconds: 96,
  });
  const kept = await recording(f, 2, {
    displayName: "Call Casey#_260927_120741.m4a", recordedAt: "2026-09-27T06:40:41Z", durationSeconds: 180,
  });
  assert.equal((await deleteHistory(f, accepted[1].id)).status, 200);
  const before = await f.DB.prepare("SELECT * FROM calls ORDER BY id").all();
  const sql = await readFile(new URL("../../../migrations/0007_recording_association.sql", import.meta.url), "utf8");
  await f.DB.batch(unstable_splitSqlQuery(sql).map((statement) => f.DB.prepare(statement)));
  const page = (await (await f.list("?hasRecording=true")).json()).items;
  assert.deepEqual(page.find((row) => row.id === accepted[0].id).recordings.map((row) => row.id), [audio.id]);
  assert.equal(page.find((row) => row.id === kept.id).kind, "recording");
  const after = await f.DB.prepare("SELECT * FROM calls ORDER BY id").all();
  assert.deepEqual(after.results.map(({ call_log_id, ...row }) => row), before.results.map(({ call_log_id, ...row }) => row));
});
