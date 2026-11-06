import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { createIdentityRepository } = await loadModule("./identity.ts");
const { createCustomerRepository } = await loadModule("./customers.ts");
const { createWhatsAppReadRepository } = await loadModule("./whatsapp-reads.ts");
const adminSecret = "synthetic-unread-admin-secret-not-for-deployment";
const tokenSecret = "synthetic-unread-token-secret-not-for-deployment";

async function fixture(t) {
  const DB = await createDatabase(t);
  await DB.prepare("UPDATE whatsapp_settings SET value = '2026-01-01T00:00:00.000Z' WHERE key = 'unread_since'").run();
  const identity = createIdentityRepository(DB, tokenSecret);
  const alice = await identity.createEmployee({ name: "Alice" });
  const bob = await identity.createEmployee({ name: "Bob" });
  const enroll = async (employee) => identity.redeemInvitation(
    (await identity.createInvitation(employee.id, "2099-01-01T00:00:00Z")).invitationCode, { model: "Synthetic" });
  const aliceDevice = await enroll(alice), bobDevice = await enroll(bob);
  const env = { DB, TOKEN_HASH_SECRET: tokenSecret, LOCAL_ADMIN_SECRET: adminSecret, ENVIRONMENT: "development" };
  const app = createApp();
  const request = (path, init = {}) => app.request(new URL(path, "http://127.0.0.1"), init, env);
  const admin = (method, path) => request(path, { method, headers: { Authorization: `Bearer ${adminSecret}` } });
  const device = (who, method, path) => request(path, { method, headers: { Authorization: `Bearer ${who.deviceToken}` } });
  const customers = createCustomerRepository(DB);
  const shared = await customers.createCustomer({ name: "Shared", phone: "9876543210", employeeIds: [alice.id, bob.id] });
  const alicesOnly = await customers.createCustomer({ name: "Alice only", phone: "9123456780", employeeIds: [alice.id] });
  let n = 0;
  const say = async (customerId, direction, at) => DB.prepare(
    `INSERT INTO whatsapp_messages (id, customer_id, direction, message_type, body, status, sent_at, source, created_at)
     VALUES (?, ?, ?, 'text', 'x', 'delivered', ?, 'import', ?)`).bind(`wam_${++n}`, customerId, direction, at, at).run();
  const unread = async (response, customerId) => (await response.json()).items.find((chat) => chat.customer.id === customerId)?.unreadCount;
  return { DB, alice, bob, aliceDevice, bobDevice, admin, device, shared, alicesOnly, say, unread };
}

test("each viewer has their own unread count, and reading as one viewer never marks it read for another", async (t) => {
  const f = await fixture(t);
  await f.say(f.shared.id, "in", "2026-10-01T10:00:00.000Z");
  await f.say(f.shared.id, "out", "2026-10-01T10:01:00.000Z");
  await f.say(f.shared.id, "in", "2026-10-01T10:02:00.000Z");
  await f.say(f.shared.id, "in", "2026-10-01T10:03:00.000Z");
  const counts = async () => [
    await f.unread(await f.admin("GET", "/v1/admin/whatsapp/chats"), f.shared.id),
    await f.unread(await f.device(f.aliceDevice, "GET", "/v1/device/whatsapp/chats"), f.shared.id),
    await f.unread(await f.device(f.bobDevice, "GET", "/v1/device/whatsapp/chats"), f.shared.id),
  ];
  assert.deepEqual(await counts(), [3, 3, 3]); // outgoing messages never count

  assert.equal((await f.admin("POST", `/v1/admin/whatsapp/chats/${f.shared.id}/read`)).status, 200);
  assert.deepEqual(await counts(), [0, 3, 3]); // the administrator's reading leaves employees unread
  assert.equal((await f.device(f.aliceDevice, "POST", `/v1/device/whatsapp/chats/${f.shared.id}/read`)).status, 200);
  assert.deepEqual(await counts(), [0, 0, 3]); // Alice's reading leaves Bob unread

  await f.say(f.shared.id, "in", "2026-10-01T11:00:00.000Z");
  assert.deepEqual(await counts(), [1, 1, 4]); // only what arrived after each marker
  await f.device(f.aliceDevice, "POST", `/v1/device/whatsapp/chats/${f.shared.id}/read`);
  await f.device(f.aliceDevice, "POST", `/v1/device/whatsapp/chats/${f.shared.id}/read`);
  assert.deepEqual(await counts(), [1, 0, 4]); // marking twice is harmless
});

test("administrators are separate viewers, and history from before the baseline is never unread", async (t) => {
  const f = await fixture(t);
  await f.say(f.shared.id, "in", "2026-10-01T10:00:00.000Z");
  const reads = createWhatsAppReadRepository(f.DB);
  const asha = { type: "admin", id: "asha@example.com" }, ravi = { type: "admin", id: "ravi@example.com" };
  assert.equal((await reads.totals(asha)).messages, 1);
  await reads.markRead(asha, f.shared.id);
  assert.deepEqual([(await reads.totals(asha)).messages, (await reads.totals(ravi)).messages], [0, 1]);
  await f.DB.prepare("UPDATE whatsapp_settings SET value = '2026-12-01T00:00:00.000Z' WHERE key = 'unread_since'").run();
  assert.deepEqual([(await reads.totals(ravi)).messages, (await reads.totals(ravi)).chats], [0, 0]);
});

test("totals count chats and messages, and an employee only counts their own customers", async (t) => {
  const f = await fixture(t);
  await f.say(f.shared.id, "in", "2026-10-01T10:00:00.000Z");
  await f.say(f.shared.id, "in", "2026-10-01T10:01:00.000Z");
  await f.say(f.alicesOnly.id, "in", "2026-10-01T10:02:00.000Z");
  const total = async (response) => { const body = await response.json(); return [body.chats, body.messages]; };
  assert.deepEqual(await total(await f.admin("GET", "/v1/admin/whatsapp/unread")), [2, 3]);
  assert.deepEqual(await total(await f.device(f.aliceDevice, "GET", "/v1/device/whatsapp/unread")), [2, 3]);
  assert.deepEqual(await total(await f.device(f.bobDevice, "GET", "/v1/device/whatsapp/unread")), [1, 2]);
  await f.device(f.aliceDevice, "POST", `/v1/device/whatsapp/chats/${f.alicesOnly.id}/read`);
  assert.deepEqual(await total(await f.device(f.aliceDevice, "GET", "/v1/device/whatsapp/unread")), [1, 2]);
});

test("an employee cannot mark a chat read for a customer who is not theirs; unknown customers are 404", async (t) => {
  const f = await fixture(t);
  await f.say(f.alicesOnly.id, "in", "2026-10-01T10:00:00.000Z");
  assert.equal((await f.device(f.bobDevice, "POST", `/v1/device/whatsapp/chats/${f.alicesOnly.id}/read`)).status, 404);
  assert.equal((await f.admin("POST", "/v1/admin/whatsapp/chats/cus_missing/read")).status, 404);
  assert.equal((await f.device(f.bobDevice, "POST", "/v1/device/whatsapp/chats/cus_missing/read")).status, 404);
  const rows = (await f.DB.prepare("SELECT count(*) AS n FROM whatsapp_chat_reads").first()).n;
  assert.equal(rows, 0);
});

test("marking a chat read works with a bodiless POST and still rejects a non-JSON payload", async (t) => {
  const f = await fixture(t);
  const env = { DB: f.DB, TOKEN_HASH_SECRET: tokenSecret, LOCAL_ADMIN_SECRET: adminSecret, ENVIRONMENT: "development" };
  const call = (init) => createApp().request(new URL(`/v1/admin/whatsapp/chats/${f.shared.id}/read`, "http://127.0.0.1"),
    { method: "POST", ...init, headers: { Authorization: `Bearer ${adminSecret}`, ...init.headers } }, env);
  assert.equal((await call({ headers: { "Content-Length": "0" }, body: "" })).status, 200);
  assert.equal((await call({ headers: { "Content-Type": "text/plain" }, body: "hello" })).status, 400);
});

test("the feed version moves on new messages, receipts and stored media, and not on reading chats", async (t) => {
  const f = await fixture(t);
  const version = async () => (await (await f.admin("GET", "/v1/admin/whatsapp/version")).json()).version;
  const device = async () => (await (await f.device(f.aliceDevice, "GET", "/v1/device/whatsapp/version")).json()).version;
  const start = await version();
  assert.equal(await device(), start); // one shared counter
  await f.say(f.shared.id, "in", "2026-10-01T10:00:00.000Z");
  const afterMessage = await version();
  assert.ok(afterMessage > start);
  await f.admin("GET", "/v1/admin/whatsapp/chats");
  await f.admin("POST", `/v1/admin/whatsapp/chats/${f.shared.id}/read`);
  assert.equal(await version(), afterMessage); // looking is not a change
  await f.DB.prepare("UPDATE whatsapp_messages SET status = 'read', read_at = '2026-10-01T10:05:00.000Z' WHERE customer_id = ?").bind(f.shared.id).run();
  const afterReceipt = await version();
  assert.ok(afterReceipt > afterMessage);
  await f.DB.prepare("UPDATE whatsapp_messages SET media_key = 'whatsapp-media/x' WHERE customer_id = ?").bind(f.shared.id).run();
  assert.ok((await version()) > afterReceipt);
  assert.equal((await f.device({ deviceToken: "nope" }, "GET", "/v1/device/whatsapp/version")).status, 401);
});
