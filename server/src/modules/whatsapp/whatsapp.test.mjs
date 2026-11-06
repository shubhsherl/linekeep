import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { createDatabase, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { createIdentityRepository } = await loadModule("./identity.ts");
const adminSecret = "synthetic-whatsapp-admin-secret-not-for-deployment";
const appSecret = "synthetic-app-secret";
const phoneNumberId = "1000000000000001";
const whatsapp = {
  WHATSAPP_TOKEN: "synthetic-token", WHATSAPP_PHONE_NUMBER_ID: phoneNumberId,
  WHATSAPP_WABA_ID: "1000000000000002", WHATSAPP_APP_SECRET: appSecret, WHATSAPP_VERIFY_TOKEN: "synthetic-verify",
};

async function fixture(t, extraEnv = whatsapp) {
  const DB = await createDatabase(t);
  const identity = createIdentityRepository(DB, "synthetic-whatsapp-token-secret-not-for-deployment");
  const alice = await identity.createEmployee({ name: "Alice" });
  const device = await identity.redeemInvitation(
    (await identity.createInvitation(alice.id, "2099-01-01T00:00:00Z")).invitationCode, { model: "Synthetic" });
  const env = { DB, TOKEN_HASH_SECRET: "synthetic-whatsapp-token-secret-not-for-deployment", LOCAL_ADMIN_SECRET: adminSecret, ENVIRONMENT: "development", ...extraEnv };
  const app = createApp();
  const request = (path, init = {}) => app.request(new URL(path, "http://127.0.0.1"), init, env);
  const admin = (method, path, body) => request(path, {
    method, headers: { Authorization: `Bearer ${adminSecret}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const customer = (await (await admin("POST", "/v1/admin/customers", { name: "Buyer", phone: "9876543210", employeeIds: [alice.id] })).json()).customer;
  const sign = (raw) => "sha256=" + createHmac("sha256", appSecret).update(raw).digest("hex");
  const hook = (payload, signature) => {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    return request("/v1/webhooks/whatsapp", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature ?? sign(raw) }, body: raw,
    });
  };
  const messages = async () => (await admin("GET", `/v1/admin/customers/${customer.id}/messages`).then((r) => r.json())).items;
  return { DB, alice, device, customer, request, admin, hook, messages };
}

const inbound = (id, from, extra = {}) => ({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ field: "messages", value: {
    metadata: { phone_number_id: phoneNumberId },
    contacts: [{ wa_id: from, profile: { name: "Profile Name" } }],
    messages: [{ id, from, timestamp: "1790000000", type: "text", text: { body: "hi there" } }], ...extra,
  } }] }],
});
const statusHook = (id, status, timestamp = "1790000100") => ({
  entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, statuses: [{ id, status, timestamp }] } }] }],
});

const templates = [
  { name: "hello_world", language: "en_US", status: "APPROVED", category: "UTILITY", parameter_format: "POSITIONAL", components: [
    { type: "HEADER", format: "TEXT", text: "Hello World" }, { type: "BODY", text: "Welcome and congratulations!!" }, { type: "FOOTER", text: "Sample" }] },
  { name: "order_update", language: "en_US", status: "APPROVED", category: "UTILITY", parameter_format: "POSITIONAL", components: [
    { type: "BODY", text: "Hi {{1}}, order {{2}} is ready. Thanks {{1}}!", example: { body_text: [["Asha", "A-17"]] } },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "Track", url: "https://example.com/t" }] }] },
  { name: "named_greeting", language: "en_US", status: "APPROVED", category: "MARKETING", parameter_format: "NAMED", components: [
    { type: "BODY", text: "Hello {{first_name}}", example: { body_text_named_params: [{ param_name: "first_name", example: "Asha" }] } }] },
  { name: "with_image", language: "en_US", status: "APPROVED", category: "MARKETING", parameter_format: "POSITIONAL", components: [
    { type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Look" }] },
  { name: "a_carousel", language: "en_US", status: "APPROVED", category: "MARKETING", parameter_format: "POSITIONAL", components: [
    { type: "BODY", text: "Look" }, { type: "CAROUSEL" }] },
  { name: "pending_one", language: "en_US", status: "PENDING", category: "MARKETING", components: [{ type: "BODY", text: "x" }] },
];

/** Answers template lookups itself; `handler` decides the reply to each message send. Returns the sends. */
function stubGraph(t, handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/message_templates")) {
      const wanted = new URL(String(url)).searchParams.get("name");
      return new Response(JSON.stringify({ data: templates.filter((x) => !wanted || x.name === wanted) }), { status: 200 });
    }
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return handler(calls.length);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
const ok = (id) => new Response(JSON.stringify({ messages: [{ id }] }), { status: 200 });

test("webhook handshake needs the verify token and echoes only a numeric challenge", async (t) => {
  const f = await fixture(t);
  const get = (query) => f.request(`/v1/webhooks/whatsapp?${query}`);
  const good = await get("hub.mode=subscribe&hub.verify_token=synthetic-verify&hub.challenge=12345");
  assert.equal(good.status, 200);
  assert.equal(await good.text(), "12345");
  assert.equal((await get("hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345")).status, 403);
  assert.equal((await get("hub.mode=subscribe&hub.verify_token=synthetic-verify&hub.challenge=<script>")).status, 403);
  const unconfigured = await fixture(t, {});
  assert.equal((await unconfigured.request("/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=&hub.challenge=1")).status, 403);
});

test("unsigned, wrongly signed and unconfigured webhooks store nothing", async (t) => {
  const f = await fixture(t);
  const payload = inbound("wamid.A", "919876543210");
  assert.equal((await f.hook(payload, "sha256=" + "0".repeat(64))).status, 401);
  assert.equal((await f.hook(payload, "garbage")).status, 401);
  const raw = JSON.stringify(payload);
  const tampered = await f.request("/v1/webhooks/whatsapp", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=" + createHmac("sha256", appSecret).update(raw).digest("hex") },
    body: raw.replace("hi there", "hi there!"),
  });
  assert.equal(tampered.status, 401);
  assert.equal((await f.messages()).length, 0);
  const off = await fixture(t, {});
  assert.equal((await off.hook(payload)).status, 503);
});

test("an inbound message lands on the matching customer once, however often Meta redelivers it", async (t) => {
  const f = await fixture(t);
  const payload = inbound("wamid.A", "919876543210");
  assert.equal((await f.hook(payload)).status, 200);
  assert.equal((await f.hook(payload)).status, 200);
  const items = await f.messages();
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].direction, items[0].body, items[0].sentAt], ["in", "hi there", "2026-09-21T14:13:20.000Z"]);
  const customers = (await (await f.admin("GET", "/v1/admin/customers")).json()).items;
  assert.equal(customers.length, 1);
});

test("an unknown sender becomes one unassigned customer named from their profile; other numbers' traffic is ignored", async (t) => {
  const f = await fixture(t);
  await f.hook(inbound("wamid.B", "14155550123"));
  await f.hook(inbound("wamid.C", "14155550123"));
  const created = (await (await f.admin("GET", "/v1/admin/customers?unassigned=true")).json()).items;
  assert.equal(created.length, 1);
  assert.deepEqual([created[0].name, created[0].phone, created[0].source], ["Profile Name", "+14155550123", "whatsapp"]);
  assert.equal(created[0].messageCount, 2);
  const other = inbound("wamid.D", "14155550999");
  other.entry[0].changes[0].value.metadata.phone_number_id = "999";
  await f.hook(other);
  assert.equal((await (await f.admin("GET", "/v1/admin/customers")).json()).items.length, 2);
});

test("text is refused until the customer has written in the last 24 hours; a template always goes", async (t) => {
  const f = await fixture(t);
  const calls = stubGraph(t, (n) => ok(`wamid.OUT${n}`));
  const send = (body) => f.admin("POST", `/v1/admin/customers/${f.customer.id}/messages`, body);
  const refused = await send({ clientMessageId: crypto.randomUUID(), text: "hello" });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, "TEMPLATE_REQUIRED");
  assert.equal(calls.length, 0);
  assert.equal((await f.messages()).length, 0);

  const template = await send({ clientMessageId: crypto.randomUUID(), template: { name: "hello_world" } });
  assert.equal(template.status, 201);
  assert.equal(calls[0].body.type, "template");
  assert.deepEqual(calls[0].body.template, { name: "hello_world", language: { code: "en_US" } });
  assert.equal((await f.messages())[0].body, "Hello World\nWelcome and congratulations!!\nSample");
  assert.equal(calls[0].body.to, "919876543210");
  assert.equal(calls[0].headers.Authorization, "Bearer synthetic-token");

  await f.DB.prepare("INSERT INTO whatsapp_messages (id, customer_id, direction, message_type, body, status, sent_at, source, created_at) VALUES ('wam_old', ?, 'in', 'text', 'old', 'delivered', ?, 'import', ?)")
    .bind(f.customer.id, new Date(Date.now() - 25 * 3600e3).toISOString(), new Date().toISOString()).run();
  assert.equal((await send({ clientMessageId: crypto.randomUUID(), text: "late" })).status, 409);
  await f.hook({ ...inbound("wamid.E", "919876543210"), entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId },
    messages: [{ id: "wamid.E", from: "919876543210", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "now" } }] } }] }] });
  const sent = await send({ clientMessageId: crypto.randomUUID(), text: "inside the window" });
  assert.equal(sent.status, 201);
  assert.deepEqual(calls.at(-1).body.text, { body: "inside the window", preview_url: false });
});

test("a retried send with the same client id reaches Meta once", async (t) => {
  const f = await fixture(t);
  const calls = stubGraph(t, () => ok("wamid.ONCE"));
  const body = { clientMessageId: crypto.randomUUID(), template: { name: "hello_world", language: "en_US" } };
  const first = await (await f.admin("POST", `/v1/admin/customers/${f.customer.id}/messages`, body)).json();
  const second = await f.admin("POST", `/v1/admin/customers/${f.customer.id}/messages`, body);
  assert.equal(second.status, 201);
  assert.equal((await second.json()).message.id, first.message.id);
  assert.equal(calls.length, 1);
  assert.equal((await f.messages()).length, 1);
});

test("delivery receipts advance status and never move it backwards", async (t) => {
  const f = await fixture(t);
  stubGraph(t, () => ok("wamid.TRACK"));
  const sent = await (await f.admin("POST", `/v1/admin/customers/${f.customer.id}/messages`,
    { clientMessageId: crypto.randomUUID(), template: { name: "hello_world" } })).json();
  assert.equal(sent.message.status, "sent");
  await f.hook(statusHook("wamid.TRACK", "read", "1790000300"));
  await f.hook(statusHook("wamid.TRACK", "delivered", "1790000200"));
  await f.hook(statusHook("wamid.TRACK", "sent", "1790000100"));
  const [message] = await f.messages();
  assert.equal(message.status, "read");
  assert.equal(message.readAt, "2026-09-21T14:18:20.000Z");
  assert.equal(message.deliveredAt, "2026-09-21T14:18:20.000Z");
  await f.hook(statusHook("wamid.UNKNOWN", "read"));
  assert.equal((await f.messages()).length, 1);
});

test("a Meta failure is recorded as failed and reported without leaking details", async (t) => {
  const f = await fixture(t);
  stubGraph(t, () => new Response(JSON.stringify({ error: { code: 131047, message: "secret detail" } }), { status: 400 }));
  const response = await f.admin("POST", `/v1/admin/customers/${f.customer.id}/messages`,
    { clientMessageId: crypto.randomUUID(), template: { name: "hello_world" } });
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, /WHATSAPP_SEND_FAILED/);
  assert.doesNotMatch(text, /secret detail|synthetic-token/);
  assert.equal((await f.messages())[0].status, "failed");
});

test("an employee sends only to assigned customers and is recorded as the sender", async (t) => {
  const f = await fixture(t);
  stubGraph(t, () => ok("wamid.EMP"));
  const device = (path, body) => f.request(path, { method: "POST", headers: { Authorization: `Bearer ${f.device.deviceToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const status = await (await f.request("/v1/device/whatsapp/status", { headers: { Authorization: `Bearer ${f.device.deviceToken}` } })).json();
  assert.equal(status.canSend, true);
  const body = { clientMessageId: crypto.randomUUID(), template: { name: "hello_world" } };
  const mine = await device(`/v1/device/customers/${f.customer.id}/messages`, body);
  assert.equal(mine.status, 201);
  assert.equal((await mine.json()).message.sentBy.name, "Alice");
  const other = (await (await f.admin("POST", "/v1/admin/customers", { name: "Other", phone: "9123456780" })).json()).customer;
  assert.equal((await device(`/v1/device/customers/${other.id}/messages`, { ...body, clientMessageId: crypto.randomUUID() })).status, 404);
});

test("the picker lists approved templates with variables and flags those that cannot be sent yet", async (t) => {
  const f = await fixture(t);
  stubGraph(t, () => ok("wamid.X"));
  const list = (await (await f.admin("GET", "/v1/admin/whatsapp/templates")).json()).items;
  // Sendable templates come first so the picker leads with what can be used.
  assert.deepEqual(list.map((x) => x.name), ["hello_world", "named_greeting", "order_update", "a_carousel", "with_image"]);
  assert.deepEqual(list.map((x) => x.sendable), [true, true, true, false, false]);
  const order = list.find((x) => x.name === "order_update");
  assert.deepEqual(order.variables, [{ key: "1", example: "Asha" }, { key: "2", example: "A-17" }]);
  assert.equal(order.sendable, true);
  const image = list.find((x) => x.name === "with_image");
  assert.equal(image.sendable, false);
  assert.match(image.reason, /header/);
  const off = await fixture(t, { ...whatsapp, WHATSAPP_WABA_ID: undefined });
  assert.equal((await off.admin("GET", "/v1/admin/whatsapp/templates")).status, 503);
});

test("template variables are filled into the stored text and sent as body parameters", async (t) => {
  const f = await fixture(t);
  const calls = stubGraph(t, () => ok("wamid.PARAMS"));
  const send = (template) => f.admin("POST", `/v1/admin/customers/${f.customer.id}/messages`, { clientMessageId: crypto.randomUUID(), template });
  const sent = await send({ name: "order_update", language: "en_US", params: ["Asha", "A-17"] });
  assert.equal(sent.status, 201);
  assert.equal((await sent.json()).message.body, "Hi Asha, order A-17 is ready. Thanks Asha!");
  assert.deepEqual(calls[0].body.template.components, [{ type: "body", parameters: [{ type: "text", text: "Asha" }, { type: "text", text: "A-17" }] }]);
  await send({ name: "named_greeting", language: "en_US", params: ["Bala"] });
  assert.deepEqual(calls[1].body.template.components[0].parameters, [{ type: "text", text: "Bala", parameter_name: "first_name" }]);
  for (const bad of [
    { name: "order_update", language: "en_US", params: ["only one"] },
    { name: "order_update", language: "en_US", params: [] },
    { name: "order_update", language: "en_US", params: ["a", "line\nbreak"] },
    { name: "with_image", language: "en_US", params: [] },
  ]) assert.equal((await send(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await send({ name: "pending_one", language: "en_US", params: [] })).status, 404);
  assert.equal((await send({ name: "order_update", language: "fr_FR", params: ["a", "b"] })).status, 404);
  assert.equal(calls.length, 2);
  assert.equal((await f.messages()).length, 2);
});

test("inbound button taps, list choices, reactions and captions keep the words the customer saw", async (t) => {
  const f = await fixture(t);
  const send = (id, type, body) => f.hook({ entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId },
    messages: [{ id, from: "919876543210", timestamp: "1790000000", type, ...body }] } }] }] });
  await send("wamid.BTN", "button", { button: { payload: "p1", text: "Yes, interested" } });
  await send("wamid.INT", "interactive", { interactive: { type: "button_reply", button_reply: { id: "b1", title: "Call me" } } });
  await send("wamid.LST", "interactive", { interactive: { type: "list_reply", list_reply: { id: "l1", title: "Pricing", description: "x" } } });
  await send("wamid.IMG", "image", { image: { id: "m1", caption: "my shop" } });
  await send("wamid.RCT", "reaction", { reaction: { message_id: "x", emoji: "👍" } });
  const bodies = Object.fromEntries((await f.messages()).map((m) => [m.messageType + ":" + m.body, true]));
  assert.deepEqual(Object.keys(bodies).sort(), ["button:Yes, interested", "image:my shop", "interactive:Call me", "interactive:Pricing", "reaction:👍"]);
});
