import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";

import { loadModule } from "../../data/test-support.mjs";

const { createIdentityRepository } = await loadModule("./identity.ts");
const { createCallRepository } = await loadModule("./calls.ts");
const { signMediaCapability } = await loadModule(
  "../modules/recordings/capabilities.ts",
);
const secret = "synthetic-recording-secret-not-for-deployment";
const audio = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0]);

// Execute the real handler inside workerd: FixedLengthStream and conditional R2
// writes cannot be faithfully exercised by a Node-only storage fake.
const bundle = await build({
  stdin: {
    contents: `
      import { Hono } from 'hono';
      import { handleError } from '../../http/errors.ts';
      import { createRecordingRoutes } from './index.ts';
      import { createCallRepository } from '../../data/calls.ts';
      import { createIdentityRepository } from '../../data/identity.ts';
      const app = new Hono();
      app.use('*', async (c, next) => { c.set('requestId', 'req_recording_test'); await next(); });
      app.route('/v1/device/uploads', createRecordingRoutes());
      app.onError(handleError);
      export default {
        async fetch(request, env, ctx) {
          const race = request.headers.get('x-test-race');
          if (!race) return app.fetch(request, env, ctx);
          const bucket = env.RECORDINGS;
          const calls = createCallRepository(env.DB);
          const identity = createIdentityRepository(env.DB, env.TOKEN_HASH_SECRET);
          const callId = new URL(request.url).pathname.split('/').at(-2);
          const call = await calls.getById(callId);
          const wrapped = {
            head: bucket.head.bind(bucket),
            delete: bucket.delete.bind(bucket),
            async put(key, body, options) {
              if (race === 'competing-winner') {
                await bucket.put(key, new Uint8Array(call.expectedBytes).fill(7), { httpMetadata: { contentType: call.contentType } });
              }
              const result = await bucket.put(key, body, options);
              if (race === 'delete-after-write') await calls.markDeleted(callId);
              if (race === 'revoke-after-write' || race === 'complete-and-revoke') {
                if (race === 'complete-and-revoke') await calls.complete(callId, call.deviceId, { actualBytes: result.size, etag: result.etag });
                await identity.revokeDevice(call.deviceId);
              }
              return result;
            },
          };
          return app.fetch(request, { ...env, RECORDINGS: wrapped }, ctx);
        },
      };
    `,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    sourcefile: "recording-test-worker.ts",
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
});

async function fixture(t) {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "recording-tests",
          compatibilityDate: "2026-09-24",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": { type: "esm", contents: bundle.outputFiles[0].text },
            },
          },
          env: {
            DB: { type: "d1", id: "recording-tests" },
            RECORDINGS: { type: "r2", name: "recording-tests" },
            TOKEN_HASH_SECRET: { type: "text", value: secret },
            MAX_RECORDING_BYTES: { type: "text", value: "32" },
            ENVIRONMENT: { type: "text", value: "development" },
          },
        },
      },
    ],
  });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("DB");
  const bucket = await runtime.getR2Bucket("RECORDINGS");
  const migrations = new URL("../../../migrations/", import.meta.url);
  for (const name of (await readdir(migrations))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const statements = unstable_splitSqlQuery(
      await readFile(new URL(name, migrations), "utf8"),
    );
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
  const identity = createIdentityRepository(db, secret);
  const calls = createCallRepository(db);
  const employee = await identity.createEmployee({
    name: "Synthetic recording employee",
  });
  async function register() {
    const invitation = await identity.createInvitation(
      employee.id,
      new Date(Date.now() + 60_000).toISOString(),
    );
    return identity.redeemInvitation(invitation.invitationCode, {
      model: "Synthetic test device",
    });
  }
  const device = await register();
  const other = await register();
  async function json(path, value, credential = device) {
    return runtime.dispatchFetch(
      `https://recordings.test/v1/device/uploads/${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential.deviceToken}`,
        },
        body: JSON.stringify(value),
      },
    );
  }
  async function prepare(value = recording(), credential = device) {
    const response = await json("prepare", value, credential);
    assert.equal(response.status, 200);
    return response.json();
  }
  function put(prepared, body = audio, extraHeaders = {}) {
    return runtime.dispatchFetch(prepared.upload.url, {
      method: "PUT",
      headers: { ...prepared.upload.headers, ...extraHeaders },
      body,
      duplex: "half",
    });
  }
  return {
    runtime,
    db,
    bucket,
    identity,
    calls,
    employee,
    device,
    other,
    json,
    prepare,
    put,
  };
}

function recording(fingerprint = "a".repeat(64), file = {}, call = {}) {
  return {
    fingerprint,
    file: {
      displayName: "Synthetic.wav",
      contentType: "audio/wav",
      expectedBytes: audio.byteLength,
      ...file,
    },
    call: { matchStatus: "unmatched", ...call },
  };
}

test("prepare and complete replay one immutable per-device recording and quoted upload ETags work", async (t) => {
  const f = await fixture(t);
  const first = await f.prepare();
  const changed = await f.prepare(
    recording(
      "a".repeat(64),
      {
        displayName: "Changed.mp3",
        contentType: "audio/mpeg",
        expectedBytes: 2,
      },
      { direction: "incoming" },
    ),
  );
  assert.equal(changed.callId, first.callId);
  assert.equal(changed.upload.headers["Content-Type"], "audio/wav");
  const stored = await f.calls.getById(first.callId);
  assert.equal(stored.displayName, "Synthetic.wav");
  assert.equal(stored.expectedBytes, audio.byteLength);
  assert.equal(stored.direction, undefined);
  const other = await f.prepare(recording(), f.other);
  assert.notEqual(other.callId, first.callId);
  const upload = await f.put(first);
  assert.equal(upload.status, 200);
  const etag = upload.headers.get("ETag");
  assert.match(etag, /^".+"$/);
  assert.equal(
    (await f.put(changed, new Uint8Array(audio.byteLength).fill(9))).status,
    200,
  );
  assert.deepEqual(
    new Uint8Array(await (await f.bucket.get(stored.objectKey)).arrayBuffer()),
    audio,
  );
  assert.equal(
    (
      await f.json(
        `${first.callId}/complete`,
        { actualBytes: audio.byteLength },
        f.other,
      )
    ).status,
    404,
  );
  const complete = await f.json(`${first.callId}/complete`, {
    actualBytes: audio.byteLength,
    etag,
  });
  assert.equal(complete.status, 200);
  const completed = await complete.json();
  const replay = await f.json(`${first.callId}/complete`, {
    actualBytes: 1,
    etag: "stale-client-value",
  });
  assert.deepEqual(await replay.json(), completed);
  assert.equal((await f.prepare()).status, "complete");
  assert.equal(
    (await f.calls.getById(first.callId)).objectEtag,
    etag.slice(1, -1),
  );
  assert.deepEqual(Object.keys(completed).sort(), [
    "callId",
    "requestId",
    "status",
    "uploadedAt",
  ]);
});

test("prepare rejects malformed required fields, invalid metadata and the configured byte ceiling", async (t) => {
  const f = await fixture(t);
  const invalid = [
    { ...recording(), fingerprint: "A".repeat(64) },
    recording("a".repeat(64), { displayName: "" }),
    recording("a".repeat(64), { contentType: "application/octet-stream" }),
    recording("a".repeat(64), { expectedBytes: 0 }),
    recording("a".repeat(64), { expectedBytes: 1.5 }),
    recording("a".repeat(64), { expectedBytes: Number.MAX_SAFE_INTEGER + 1 }),
    recording("a".repeat(64), { recordedAt: "2026-09-24T12:00:00+01:00" }),
    recording("a".repeat(64), { durationSeconds: -1 }),
    recording("a".repeat(64), {}, { matchStatus: undefined }),
  ];
  for (const value of invalid)
    assert.equal((await f.json("prepare", value)).status, 400);
  assert.equal(
    (await f.json("prepare", recording("a".repeat(64), { expectedBytes: 33 })))
      .status,
    413,
  );
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) AS count FROM calls").first()).count,
    0,
  );
});

test("signed upload rejects expired, tampered and read-method capabilities before storing bytes", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const call = await f.calls.getById(prepared.callId);
  const tampered = new URL(prepared.upload.url);
  tampered.searchParams.set("signature", "0".repeat(64));
  assert.equal(
    (
      await f.put({
        ...prepared,
        upload: { ...prepared.upload, url: tampered.href },
      })
    ).status,
    401,
  );
  for (const [method, expiresAt] of [
    ["PUT", new Date(Date.now() - 1000).toISOString()],
    ["GET", prepared.upload.expiresAt],
  ]) {
    const url = new URL(prepared.upload.url);
    url.searchParams.set("expiresAt", expiresAt);
    url.searchParams.set(
      "signature",
      await signMediaCapability(secret, method, call.objectKey, expiresAt),
    );
    assert.equal(
      (
        await f.put({
          ...prepared,
          upload: { ...prepared.upload, url: url.href },
        })
      ).status,
      401,
    );
  }
  const other = await f.prepare(recording("b".repeat(64)));
  const wrongKey = prepared.upload.url.replace(prepared.callId, other.callId);
  assert.equal(
    (
      await f.put({
        ...prepared,
        upload: { ...prepared.upload, url: wrongKey },
      })
    ).status,
    401,
  );
  assert.equal(await f.bucket.head(call.objectKey), null);
});

test("PUT counts streamed bytes, rejects wrong types, and leaves no partial object", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const call = await f.calls.getById(prepared.callId);
  assert.equal(
    (await f.put(prepared, audio, { "Content-Type": "audio/mpeg" })).status,
    400,
  );
  for (const length of [3, 9, 33]) {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(length));
        controller.close();
      },
    });
    const response = await f.put(prepared, body);
    assert.equal(response.status, length > 32 ? 413 : 400);
    assert.equal(await f.bucket.head(call.objectKey), null);
  }
  const extraChunk = new ReadableStream({
    start(controller) {
      controller.enqueue(audio);
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  assert.equal((await f.put(prepared, extraChunk)).status, 400);
  assert.equal(await f.bucket.head(call.objectKey), null);
  assert.equal((await f.put(prepared)).status, 200);
});

test("complete verifies the real object, size, stored type and ETag, not client assertions", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const call = await f.calls.getById(prepared.callId);
  const complete = (value = { actualBytes: audio.byteLength }) =>
    f.json(`${prepared.callId}/complete`, value);
  assert.equal((await complete()).status, 409);
  await f.bucket.put(call.objectKey, new Uint8Array(3), {
    httpMetadata: { contentType: "audio/wav" },
  });
  assert.equal((await complete()).status, 409);
  await f.bucket.put(call.objectKey, audio, {
    httpMetadata: { contentType: "audio/mpeg" },
  });
  assert.equal((await complete()).status, 409);
  await f.bucket.put(call.objectKey, audio, {
    httpMetadata: { contentType: "audio/wav" },
  });
  assert.equal((await complete({ actualBytes: 2 })).status, 409);
  assert.equal(
    (await complete({ actualBytes: audio.byteLength, etag: "wrong" })).status,
    409,
  );
  assert.equal((await f.calls.getById(call.id)).uploadStatus, "pending");
  assert.equal((await complete()).status, 200);
});

test("failed calls require prepare retry; deleted calls and stale capabilities cannot resurrect", async (t) => {
  const f = await fixture(t);
  const first = await f.prepare();
  await f.calls.markFailed(first.callId, f.device.device.id);
  assert.equal((await f.put(first)).status, 409);
  assert.equal(
    (
      await f.json(`${first.callId}/complete`, {
        actualBytes: audio.byteLength,
      })
    ).status,
    409,
  );
  const retry = await f.prepare();
  assert.equal(retry.callId, first.callId);
  assert.equal((await f.put(retry)).status, 200);
  const call = await f.calls.getById(first.callId);
  await f.bucket.delete(call.objectKey);
  await f.calls.markDeleted(call.id);
  assert.equal((await f.put(retry)).status, 409);
  assert.equal((await f.json("prepare", recording())).status, 409);
  assert.equal(
    (await f.json(`${call.id}/complete`, { actualBytes: audio.byteLength }))
      .status,
    409,
  );
  assert.equal(await f.bucket.head(call.objectKey), null);
});

test("revocation and inactive employees invalidate outstanding upload capabilities", async (t) => {
  const f = await fixture(t);
  const first = await f.prepare();
  const second = await f.prepare(recording(), f.other);
  await f.identity.revokeDevice(f.device.device.id);
  assert.equal((await f.put(first)).status, 401);
  assert.equal((await f.json("prepare", recording())).status, 401);
  assert.equal((await f.put(second)).status, 200);
  await f.identity.setEmployeeActive(f.employee.id, false);
  assert.equal((await f.put(second)).status, 401);
  assert.equal(
    (
      await f.json(
        `${second.callId}/complete`,
        { actualBytes: audio.byteLength },
        f.other,
      )
    ).status,
    401,
  );
});

test("conditional R2 create never overwrites or deletes a competing successful upload", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const response = await f.put(prepared, audio, {
    "x-test-race": "competing-winner",
  });
  assert.equal(response.status, 409);
  const call = await f.calls.getById(prepared.callId);
  const winner = new Uint8Array(audio.byteLength).fill(7);
  assert.deepEqual(
    new Uint8Array(await (await f.bucket.get(call.objectKey)).arrayBuffer()),
    winner,
  );
  assert.equal((await f.put(prepared)).status, 200);
  assert.deepEqual(
    new Uint8Array(await (await f.bucket.get(call.objectKey)).arrayBuffer()),
    winner,
  );
});

for (const [race, expectedStatus] of [
  ["delete-after-write", 409],
  ["revoke-after-write", 401],
  ["complete-and-revoke", 401],
]) {
  test(`post-write ${race} cleans only an uncompleted write owned by this request`, async (t) => {
    const f = await fixture(t);
    const prepared = await f.prepare();
    const response = await f.put(prepared, audio, { "x-test-race": race });
    assert.equal(response.status, expectedStatus);
    const call = await f.calls.getById(prepared.callId);
    const object = await f.bucket.head(call.objectKey);
    if (race === "complete-and-revoke") {
      assert.equal(call.uploadStatus, "complete");
      assert.equal(object.size, audio.byteLength);
    } else {
      assert.equal(object, null);
    }
  });
}

test("pending audio and completion survive handover while ownership, active employees, and revocation remain enforced", async (t) => {
  const f = await fixture(t);
  const pending = await f.prepare();
  const next = await f.identity.createEmployee({
    name: "Next recording employee",
  });
  const assigned = await f.identity.reassignDevice(f.device.device.id, next.id);
  const replay = await f.prepare();
  assert.equal(replay.callId, pending.callId);
  assert.equal((await f.put(pending)).status, 200);
  assert.equal(
    (
      await f.json(`${pending.callId}/complete`, {
        actualBytes: audio.byteLength,
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.calls.getById(pending.callId)).employeeId,
    f.employee.id,
  );
  const ambiguous = await f.json("prepare", recording("b".repeat(64)));
  assert.equal(ambiguous.status, 409);
  assert.equal((await ambiguous.json()).error.code, "INVALID_STATE");
  const historical = await f.prepare(
    recording("c".repeat(64), {
      recordedAt: new Date(Date.parse(assigned.assignedAt) - 1).toISOString(),
    }),
  );
  const boundary = await f.prepare(
    recording("d".repeat(64), { recordedAt: assigned.assignedAt }),
  );
  assert.equal(
    (await f.calls.getById(historical.callId)).employeeId,
    f.employee.id,
  );
  assert.equal((await f.calls.getById(boundary.callId)).employeeId, next.id);
  await f.identity.setEmployeeActive(f.employee.id, false);
  assert.equal((await f.put(historical)).status, 401);
  assert.equal(
    (
      await f.json(`${pending.callId}/complete`, {
        actualBytes: audio.byteLength,
      })
    ).status,
    401,
  );
  await f.identity.setEmployeeActive(f.employee.id, true);
  assert.equal((await f.put(historical)).status, 200);
  await f.identity.setEmployeeActive(next.id, false);
  assert.equal(
    (
      await f.json(`${historical.callId}/complete`, {
        actualBytes: audio.byteLength,
      })
    ).status,
    401,
  );
  await f.identity.setEmployeeActive(next.id, true);
  assert.equal(
    (
      await f.json(`${historical.callId}/complete`, {
        actualBytes: audio.byteLength,
      })
    ).status,
    200,
  );
  await f.identity.revokeDevice(f.device.device.id);
  assert.equal((await f.put(boundary)).status, 401);
  assert.equal(
    (
      await f.json(`${boundary.callId}/complete`, {
        actualBytes: audio.byteLength,
      })
    ).status,
    401,
  );
});
