import assert from "node:assert/strict";
import test from "node:test";

import { Miniflare } from "miniflare";

import { createDatabase, loadModule } from "../../data/test-support.mjs";

const { createAdminCallRoutes } = await loadModule(
  "../modules/admin-calls/index.ts",
);
const { createAdminCallTestApp } = await loadModule(
  "../modules/admin-calls/test-app.ts",
);
const { createIdentityRepository } = await loadModule("./identity.ts");
const { createCallRepository } = await loadModule("./calls.ts");
const { signMediaCapability } = await loadModule(
  "../modules/recordings/capabilities.ts",
);
const secret = "synthetic-test-signing-key-never-deploy";
const start = "2026-09-24T12:00:00.000Z";
const bytes = new TextEncoder().encode("0123456789");

async function fixture(t) {
  const db = await createDatabase(t);
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "admin-call-tests",
          compatibilityDate: "2026-09-24",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents:
                  "export default { fetch() { return new Response(null, { status: 404 }); } }",
              },
            },
          },
          env: { RECORDINGS: { type: "r2", name: "admin-test-recordings" } },
        },
      },
    ],
  });
  t.after(() => runtime.dispose());
  const bucket = await runtime.getR2Bucket("RECORDINGS");
  const identity = createIdentityRepository(db, secret, () => new Date(start));
  const calls = createCallRepository(db, () => new Date(start));
  const employee = await identity.createEmployee({
    name: "Synthetic employee",
  });
  async function register(employeeId = employee.id) {
    const invitation = await identity.createInvitation(
      employeeId,
      "2026-09-24T13:00:00.000Z",
    );
    return (await identity.redeemInvitation(invitation.invitationCode, {}))
      .device;
  }
  const device = await register();
  let sequence = 0;
  async function recording(extra = {}, complete = true) {
    const pending = await calls.createPending({
      deviceId: device.id,
      fingerprint: (++sequence).toString(16).padStart(64, "0"),
      displayName: "Synthetic recording.wav",
      contentType: "audio/wav",
      expectedBytes: bytes.length,
      matchStatus: "unmatched",
      ...extra,
    });
    if (!complete) return pending;
    const object = await bucket.put(pending.objectKey, bytes, {
      httpMetadata: { contentType: "audio/wav" },
    });
    return calls.complete(pending.id, pending.deviceId, {
      actualBytes: bytes.length,
      etag: object.etag,
    });
  }
  const bindings = { DB: db, RECORDINGS: bucket, TOKEN_HASH_SECRET: secret };
  const app = createAdminCallTestApp();
  function request(path, { authorized = true, headers = {}, ...init } = {}) {
    return app.request(
      path,
      {
        ...init,
        headers: {
          ...(authorized ? { Authorization: "Bearer synthetic-admin" } : {}),
          ...headers,
        },
      },
      bindings,
    );
  }
  async function playback(call) {
    const response = await request(`/v1/admin/calls/${call.id}/playback`, {
      method: "POST",
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  return {
    db,
    bucket,
    bindings,
    calls,
    identity,
    employee,
    device,
    register,
    recording,
    request,
    playback,
  };
}

test("admin filters and opaque pagination preserve deterministic ordering and only expose contract fields", async (t) => {
  const f = await fixture(t);
  const otherEmployee = await f.identity.createEmployee({
    name: "Other synthetic employee",
  });
  const otherDevice = await f.register(otherEmployee.id);
  const a = await f.recording({
    recordedAt: "2026-09-24T10:00:00Z",
    remoteNumber: "synthetic_%_one",
    direction: "outgoing",
    durationSeconds: 0,
  });
  const b = await f.recording({
    recordedAt: "2026-09-24T10:00:00Z",
    remoteNumber: "synthetic_X_one",
    direction: "incoming",
  });
  const c = await f.recording({
    deviceId: otherDevice.id,
    recordedAt: "2026-09-24T09:00:00Z",
    direction: "unknown",
  });
  const pending = await f.recording({}, false);
  const expected = [pending.id, ...[a.id, b.id].sort().reverse(), c.id];
  const seen = [];
  let cursor;
  do {
    const query = new URLSearchParams({
      limit: "1",
      ...(cursor ? { cursor } : {}),
    });
    const response = await f.request(`/v1/admin/calls?${query}`);
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.requestId, "req_admin_test");
    seen.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, expected);
  const filters = new URLSearchParams({
    employeeId: f.employee.id,
    direction: "outgoing",
    number: "_%_",
    status: "complete",
    from: "2026-09-24T10:00:00Z",
    to: "2026-09-24T10:00:00Z",
  });
  const filtered = await (await f.request(`/v1/admin/calls?${filters}`)).json();
  assert.deepEqual(filtered.items, [
    {
      id: a.id,
      employee: { id: f.employee.id, name: f.employee.name },
      deviceId: f.device.id,
      displayName: a.displayName,
      remoteNumber: a.remoteNumber,
      direction: "outgoing",
      recordedAt: "2026-09-24T10:00:00.000Z",
      durationSeconds: 0,
      matchStatus: "unmatched",
      uploadStatus: "complete",
      actualBytes: bytes.length,
      uploadedAt: start,
    },
  ]);
  for (const [query, ids] of [
    [`employeeId=${otherEmployee.id}`, [c.id]],
    ["direction=incoming", [b.id]],
    ["status=pending", [pending.id]],
    ["from=2026-09-24T11%3A00%3A00Z", [pending.id]],
    ["to=2026-09-24T09%3A00%3A00Z", [c.id]],
  ]) {
    const page = await (await f.request(`/v1/admin/calls?${query}`)).json();
    assert.deepEqual(
      page.items.map((item) => item.id),
      ids,
    );
  }
  const missing = await (
    await f.request("/v1/admin/calls?status=pending")
  ).json();
  assert.deepEqual(missing.items[0], {
    id: pending.id,
    employee: { id: f.employee.id, name: f.employee.name },
    deviceId: f.device.id,
    displayName: pending.displayName,
    matchStatus: "unmatched",
    uploadStatus: "pending",
  });
});

test("invalid filters, duplicate parameters, and malformed or unbounded cursors fail safely", async (t) => {
  const { request } = await fixture(t);
  const cursor = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=1.5",
    "limit=1&limit=2",
    "direction=sideways",
    "status=ready",
    "from=2026-09-25T00:00:00Z&to=2026-09-24T00:00:00Z",
    "from=not-a-date",
    "cursor=%%%",
    `cursor=${"a".repeat(2049)}`,
    `cursor=${cursor({ sortAt: start })}`,
    `cursor=${cursor({ sortAt: "invalid", id: "call_test" })}`,
    `cursor=${cursor({ sortAt: start, id: "call_test", objectKey: "private" })}`,
  ]) {
    const response = await request(`/v1/admin/calls?${query}`);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).requestId, "req_admin_test");
  }
});

test("all admin routes require authorization even with a valid playback capability", async (t) => {
  const f = await fixture(t);
  const call = await f.recording();
  const { url } = await f.playback(call);
  assert.throws(() => createAdminCallRoutes(), /authorization is required/);
  for (const [path, method] of [
    ["/v1/admin/calls", "GET"],
    [`/v1/admin/calls/${call.id}/playback`, "POST"],
    [url, "GET"],
    [url, "HEAD"],
    [`/v1/admin/calls/${call.id}`, "DELETE"],
  ]) {
    const response = await f.request(path, { method, authorized: false });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("Cache-Control"), /no-store/);
  }
  assert.equal((await f.calls.getById(call.id)).uploadStatus, "complete");
  assert.equal((await f.bucket.head(call.objectKey)).size, bytes.length);
});

test("playback requires completed existing audio and capabilities expire, bind scope, and fail closed", async (t) => {
  const f = await fixture(t);
  const pending = await f.recording({}, false);
  assert.equal(
    (
      await f.request(`/v1/admin/calls/${pending.id}/playback`, {
        method: "POST",
      })
    ).status,
    409,
  );
  const call = await f.recording();
  const other = await f.recording();
  const before = Date.now();
  const playback = await f.playback(call);
  assert.equal(playback.requestId, "req_admin_test");
  assert.equal(playback.contentType, "audio/wav");
  assert.ok(Date.parse(playback.expiresAt) > before);
  assert.ok(Date.parse(playback.expiresAt) <= Date.now() + 5 * 60 * 1000);
  assert.equal(playback.url.includes(call.objectKey), false);
  const expired = new URL(playback.url);
  const expiry = new Date(Date.now() - 1000).toISOString();
  expired.searchParams.set("expiresAt", expiry);
  expired.searchParams.set(
    "signature",
    await signMediaCapability(secret, "GET", call.objectKey, expiry),
  );
  assert.equal((await f.request(expired.toString())).status, 401);
  const tampered = new URL(playback.url);
  tampered.searchParams.set(
    "expiresAt",
    new Date(Date.now() + 600000).toISOString(),
  );
  assert.equal((await f.request(tampered.toString())).status, 401);
  const wrongMethod = new URL(playback.url);
  wrongMethod.searchParams.set(
    "signature",
    await signMediaCapability(
      secret,
      "PUT",
      call.objectKey,
      playback.expiresAt,
    ),
  );
  assert.equal((await f.request(wrongMethod.toString())).status, 401);
  assert.equal(
    (await f.request(playback.url.replace(call.id, other.id))).status,
    401,
  );
  assert.equal(
    (await f.request(`/v1/admin/calls/${call.id}/audio`)).status,
    401,
  );
  f.bindings.TOKEN_HASH_SECRET = "short";
  assert.equal((await f.request(playback.url)).status, 500);
  assert.equal(
    (await f.request(`/v1/admin/calls/${call.id}/playback`, { method: "POST" }))
      .status,
    500,
  );
  f.bindings.TOKEN_HASH_SECRET = secret;
  await f.bucket.delete(call.objectKey);
  assert.equal(
    (await f.request(`/v1/admin/calls/${call.id}/playback`, { method: "POST" }))
      .status,
    404,
  );
  assert.equal((await f.request(playback.url)).status, 404);
  await f.calls.markDeleted(other.id);
  assert.equal(
    (
      await f.request(`/v1/admin/calls/${other.id}/playback`, {
        method: "POST",
      })
    ).status,
    404,
  );
});

test("private audio supports HEAD, byte ranges, validators, and safe download disposition", async (t) => {
  const f = await fixture(t);
  const call = await f.recording({
    displayName: '../Synthetic " recording\r\nX-Injected: yes.wav',
  });
  const { url } = await f.playback(call);
  const full = await f.request(url);
  assert.equal(full.status, 200);
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes);
  assert.equal(full.headers.get("Content-Type"), "audio/wav");
  assert.equal(full.headers.get("Content-Length"), String(bytes.length));
  assert.equal(
    full.headers.get("ETag"),
    (await f.bucket.head(call.objectKey)).httpEtag,
  );
  assert.equal(full.headers.get("Accept-Ranges"), "bytes");
  assert.match(full.headers.get("Cache-Control"), /no-store/);
  assert.match(full.headers.get("Content-Disposition"), /^inline;/);
  const head = await f.request(url, {
    method: "HEAD",
    headers: { Range: "bytes=2-4" },
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Length"), "10");
  assert.equal(await head.text(), "");
  for (const [range, body, contentRange] of [
    ["bytes=2-4", "234", "bytes 2-4/10"],
    ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=-2", "89", "bytes 8-9/10"],
    ["bytes=8-99", "89", "bytes 8-9/10"],
  ]) {
    const response = await f.request(url, { headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), body);
    assert.equal(response.headers.get("Content-Range"), contentRange);
    assert.equal(response.headers.get("Content-Length"), String(body.length));
  }
  for (const range of ["bytes=10-", "bytes=4-2", "bytes=-0", "bytes=0-1,4-5"]) {
    const response = await f.request(url, { headers: { Range: range } });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("Content-Range"), "bytes */10");
    assert.equal(await response.text(), "");
  }
  const stale = await f.request(url, {
    headers: { Range: "bytes=2-4", "If-Range": '"stale"' },
  });
  assert.equal(stale.status, 200);
  assert.equal(await stale.text(), "0123456789");
  const fresh = await f.request(url, {
    headers: { Range: "bytes=2-4", "If-Range": full.headers.get("ETag") },
  });
  assert.equal(fresh.status, 206);
  assert.equal(await fresh.text(), "234");
  const download = await f.request(`${url}&download=1`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "0123456789");
  assert.match(
    download.headers.get("Content-Disposition"),
    /^attachment; filename="[^"\r\n/\\]+"; filename\*=UTF-8''/,
  );
  assert.equal(download.headers.has("X-Injected"), false);
});

test("deletion retries R2 and D1 failures, invalidates playback, and preserves the device fingerprint tombstone", async (t) => {
  const f = await fixture(t);
  const call = await f.recording();
  const { url } = await f.playback(call);
  const path = `/v1/admin/calls/${call.id}`;
  f.bindings.RECORDINGS = new Proxy(f.bucket, {
    get(target, property) {
      if (property === "delete")
        return async () => {
          throw new Error("synthetic R2 failure");
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  assert.equal((await f.request(path, { method: "DELETE" })).status, 500);
  assert.equal((await f.calls.getById(call.id)).uploadStatus, "complete");
  assert.equal((await f.bucket.head(call.objectKey)).size, bytes.length);
  f.bindings.RECORDINGS = f.bucket;
  await f.db
    .prepare(
      "CREATE TRIGGER reject_call_deletion BEFORE UPDATE OF upload_status ON calls WHEN NEW.upload_status = 'deleted' BEGIN SELECT RAISE(ABORT, 'synthetic D1 failure'); END",
    )
    .run();
  assert.equal((await f.request(path, { method: "DELETE" })).status, 500);
  assert.equal(await f.bucket.head(call.objectKey), null);
  assert.equal((await f.calls.getById(call.id)).uploadStatus, "complete");
  await f.db.prepare("DROP TRIGGER reject_call_deletion").run();
  for (let retry = 0; retry < 2; retry++) {
    const response = await f.request(path, { method: "DELETE" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      requestId: "req_admin_test",
      callId: call.id,
      status: "deleted",
    });
  }
  assert.equal((await f.request(url)).status, 404);
  assert.equal((await f.calls.getById(call.id)).uploadStatus, "deleted");
  const repeat = await f.calls.createPending({
    deviceId: f.device.id,
    fingerprint: call.fingerprint,
    displayName: "Replay.wav",
    contentType: "audio/wav",
    expectedBytes: bytes.length,
    matchStatus: "unmatched",
  });
  assert.equal(repeat.id, call.id);
  assert.equal(repeat.uploadStatus, "deleted");
  assert.equal(
    (await f.request("/v1/admin/calls/call_missing", { method: "DELETE" }))
      .status,
    200,
  );
});

test("deletion cleans a racing upload after tombstoning and can retry a final R2 failure", async (t) => {
  const f = await fixture(t);
  const call = await f.recording();
  let deletes = 0;
  f.bindings.RECORDINGS = new Proxy(f.bucket, {
    get(target, property) {
      if (property === "delete")
        return async (key) => {
          deletes++;
          if (deletes === 2)
            throw new Error("synthetic post-tombstone R2 failure");
          await target.delete(key);
          if (deletes === 1) await target.put(key, bytes);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const path = `/v1/admin/calls/${call.id}`;
  assert.equal((await f.request(path, { method: "DELETE" })).status, 500);
  assert.equal((await f.calls.getById(call.id)).uploadStatus, "deleted");
  assert.equal((await f.bucket.head(call.objectKey)).size, bytes.length);
  assert.equal((await f.request(path, { method: "DELETE" })).status, 200);
  assert.equal(await f.bucket.head(call.objectKey), null);
});
