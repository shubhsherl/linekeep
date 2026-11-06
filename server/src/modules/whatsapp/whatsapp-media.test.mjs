import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { createDatabase, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { createIdentityRepository } = await loadModule("./identity.ts");
const adminSecret = "synthetic-media-admin-secret-not-for-deployment";
const tokenSecret = "synthetic-media-token-secret-not-for-deployment";
const appSecret = "synthetic-app-secret";
const phoneNumberId = "1000000000000001";
const whatsapp = {
  WHATSAPP_TOKEN: "synthetic-token", WHATSAPP_PHONE_NUMBER_ID: phoneNumberId, WHATSAPP_WABA_ID: "1000000000000002",
  WHATSAPP_APP_SECRET: appSecret, WHATSAPP_VERIFY_TOKEN: "synthetic-verify",
};
const picture = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);

/** A minimal in-memory R2: whole objects, and the single-range form of the Range header. */
function fakeBucket() {
  const store = new Map();
  return {
    store,
    async put(key, value, options) { store.set(key, { bytes: new Uint8Array(value), contentType: options?.httpMetadata?.contentType }); return {}; },
    async get(key, options) {
      const entry = store.get(key);
      if (!entry) return null;
      const header = options?.range?.get?.("Range")?.match(/^bytes=(\d+)-(\d+)?$/);
      const offset = header ? Number(header[1]) : 0;
      const end = header?.[2] ? Number(header[2]) : entry.bytes.length - 1;
      const slice = entry.bytes.slice(offset, end + 1);
      return { body: slice, size: entry.bytes.length, httpEtag: '"etag"', httpMetadata: { contentType: entry.contentType },
        ...(header ? { range: { offset, length: slice.length } } : {}) };
    },
  };
}

async function fixture(t) {
  const DB = await createDatabase(t);
  const identity = createIdentityRepository(DB, tokenSecret);
  const alice = await identity.createEmployee({ name: "Alice" });
  const bob = await identity.createEmployee({ name: "Bob" });
  const enroll = async (e) => identity.redeemInvitation((await identity.createInvitation(e.id, "2099-01-01T00:00:00Z")).invitationCode, { model: "Synthetic" });
  const aliceDevice = await enroll(alice), bobDevice = await enroll(bob);
  const RECORDINGS = fakeBucket();
  const env = { DB, RECORDINGS, TOKEN_HASH_SECRET: tokenSecret, LOCAL_ADMIN_SECRET: adminSecret, ENVIRONMENT: "development", ...whatsapp };
  const app = createApp();
  const request = (path, init = {}) => app.request(new URL(path, "http://127.0.0.1"), init, env);
  const admin = (method, path, body, headers = {}) => request(path, { method, headers: { Authorization: `Bearer ${adminSecret}`, "Content-Type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const customer = (await (await admin("POST", "/v1/admin/customers", { name: "Buyer", phone: "9123456789", employeeIds: [alice.id] })).json()).customer;
  const hook = (item) => {
    const raw = JSON.stringify({ entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId },
      messages: [{ from: "919123456789", timestamp: String(Math.floor(Date.now() / 1000)), ...item }] } }] }] });
    return request("/v1/webhooks/whatsapp", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=" + createHmac("sha256", appSecret).update(raw).digest("hex") }, body: raw });
  };
  const thread = async () => (await (await admin("GET", `/v1/admin/customers/${customer.id}/messages`)).json()).items;
  return { DB, RECORDINGS, admin, request, hook, thread, customer, aliceDevice, bobDevice };
}

/** Meta's two-step download: id -> temporary URL -> bytes. `plan` can break either step. */
function stubMeta(t, plan = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (/graph\.facebook\.com\/v[\d.]+\/\d+$/.test(u)) {
      if (plan.metaFails) return new Response("{}", { status: 400 });
      return new Response(JSON.stringify({ url: plan.fileUrl ?? "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", mime_type: plan.mime ?? "image/jpeg", file_size: picture.length }), { status: 200 });
    }
    if (u.startsWith("https://lookaside.fbsbx.com/")) return new Response(picture, { status: 200, headers: { "Content-Type": plan.mime ?? "image/jpeg" } });
    throw new Error("unexpected fetch " + u);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
const image = (id, mediaId = "5555555555", extra = {}) => ({ id, type: "image", image: { id: mediaId, mime_type: "image/jpeg", caption: "my shop", ...extra } });

test("an incoming picture is stored privately and served to administrators with safe headers", async (t) => {
  const f = await fixture(t);
  stubMeta(t);
  assert.equal((await f.hook(image("wamid.IMG"))).status, 200);
  const [message] = await f.thread();
  assert.deepEqual([message.messageType, message.body, message.media.kind, message.media.size], ["image", "my shop", "image", picture.length]);
  assert.match(message.media.url, /^\/v1\/admin\/whatsapp\/messages\/wam_[0-9a-f-]+\/media$/);
  assert.equal(f.RECORDINGS.store.size, 1);

  const response = await f.admin("GET", message.media.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/jpeg");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(response.headers.get("Content-Security-Policy"), /sandbox/);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), picture);

  const part = await f.admin("GET", message.media.url, undefined, { Range: "bytes=2-4" });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("Content-Range"), `bytes 2-4/${picture.length}`);
  assert.equal((await part.arrayBuffer()).byteLength, 3);

  assert.equal((await f.request(message.media.url)).status, 401); // no administrator, no picture
});

test("types a browser could execute are only ever offered as downloads", async (t) => {
  const f = await fixture(t);
  stubMeta(t, { mime: "text/html" });
  await f.hook({ id: "wamid.HTML", type: "document", document: { id: "6666666666", mime_type: "text/html", filename: "evil.html" } });
  const [message] = await f.thread();
  const response = await f.admin("GET", message.media.url);
  assert.equal(response.headers.get("Content-Type"), "application/octet-stream");
  assert.match(response.headers.get("Content-Disposition"), /^attachment; filename="evil\.html"$/);
});

test("a file Meta could not deliver at first is fetched when someone opens it", async (t) => {
  const f = await fixture(t);
  stubMeta(t, { metaFails: true });
  await f.hook(image("wamid.LATE", "7777777777"));
  const [pending] = await f.thread();
  assert.equal(f.RECORDINGS.store.size, 0);
  assert.equal((await f.admin("GET", pending.media.url)).status, 404); // still unobtainable
  stubMeta(t); // Meta recovers
  assert.equal((await f.admin("GET", pending.media.url)).status, 200);
  assert.equal(f.RECORDINGS.store.size, 1);
});

test("a download URL outside Meta's hosts is never fetched", async (t) => {
  const f = await fixture(t);
  const calls = stubMeta(t, { fileUrl: "https://attacker.example/steal" });
  await f.hook(image("wamid.SSRF", "8888888888"));
  assert.equal(calls.some((url) => url.includes("attacker.example")), false);
  assert.equal(f.RECORDINGS.store.size, 0);
});

test("employees see media only from their own customers; unknown messages are 404", async (t) => {
  const f = await fixture(t);
  stubMeta(t);
  await f.hook(image("wamid.SCOPE", "9999999999"));
  const [message] = await f.thread();
  const path = message.media.url.replace("/v1/admin", "/v1/device");
  const call = (who, p) => f.request(p, { headers: { Authorization: `Bearer ${who.deviceToken}` } });
  assert.equal((await call(f.aliceDevice, path)).status, 200);
  assert.equal((await call(f.bobDevice, path)).status, 404);
  assert.equal((await f.admin("GET", "/v1/admin/whatsapp/messages/wam_00000000-0000-0000-0000-000000000000/media")).status, 404);
});
