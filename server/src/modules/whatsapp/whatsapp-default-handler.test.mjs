import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createDatabase, enableFeatures, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { createIdentityRepository } = await loadModule("./identity.ts");
const adminSecret = "synthetic-default-handler-admin-secret-not-for-deployment";
const tokenSecret = "synthetic-default-handler-token-secret-not-for-deployment";
const appSecret = "synthetic-app-secret";
const phoneNumberId = "1000000000000001";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccount = JSON.stringify({
  client_email: "push@linekeep-test.iam.gserviceaccount.com", project_id: "linekeep-test",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});
const whatsapp = {
  WHATSAPP_TOKEN: "synthetic-token", WHATSAPP_PHONE_NUMBER_ID: phoneNumberId, WHATSAPP_WABA_ID: "1000000000000002",
  WHATSAPP_APP_SECRET: appSecret, WHATSAPP_VERIFY_TOKEN: "synthetic-verify", FCM_SERVICE_ACCOUNT: serviceAccount,
};
const key = "whatsapp.defaultHandlerId";

/** Counts FCM pushes; every other outbound call is refused so nothing reaches Meta. */
function stubFetch(t) {
  const pushes = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const host = new URL(String(url)).hostname;
    if (host === "oauth2.googleapis.com") return new Response(JSON.stringify({ access_token: "synthetic-access", expires_in: 3600 }), { status: 200 });
    if (host === "fcm.googleapis.com") { pushes.push(JSON.parse(init.body).message); return new Response("{}", { status: 200 }); }
    return new Response("{}", { status: 404 });
  };
  t.after(() => { globalThis.fetch = original; });
  return pushes;
}

async function fixture(t) {
  const DB = await createDatabase(t);
  await enableFeatures(DB);
  const identity = createIdentityRepository(DB, tokenSecret);
  const alice = await identity.createEmployee({ name: "Alice" });
  const boss = await identity.createEmployee({ name: "Boss", role: "manager" });
  const bob = await identity.createEmployee({ name: "Bob" });
  const devices = {};
  for (const employee of [alice, boss, bob]) {
    devices[employee.name] = await identity.redeemInvitation((await identity.createInvitation(employee.id, "2099-01-01T00:00:00Z")).invitationCode, { model: "Synthetic" });
  }
  const env = { DB, TOKEN_HASH_SECRET: tokenSecret, LOCAL_ADMIN_SECRET: adminSecret, ENVIRONMENT: "development", ...whatsapp };
  const app = createApp();
  const request = (path, init = {}) => app.request(new URL(path, "http://127.0.0.1"), init, env);
  const admin = (method, path, body) => request(path, {
    method, headers: { Authorization: `Bearer ${adminSecret}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  for (const name of ["Alice", "Boss", "Bob"]) {
    const response = await request("/v1/device/push-token", { method: "PUT", headers: { Authorization: `Bearer ${devices[name].deviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: `fcm-token-${name}`.padEnd(40, "x") }) });
    assert.equal(response.status, 200);
  }
  const hook = (from, id, name = "Profile Name") => {
    const raw = JSON.stringify({ entry: [{ changes: [{ field: "messages", value: {
      metadata: { phone_number_id: phoneNumberId }, contacts: [{ wa_id: from, profile: { name } }],
      messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000) + 5), type: "text", text: { body: "hello" } }] } }] }] });
    return request("/v1/webhooks/whatsapp", { method: "POST", headers: { "Content-Type": "application/json",
      "X-Hub-Signature-256": "sha256=" + createHmac("sha256", appSecret).update(raw).digest("hex") }, body: raw });
  };
  const setHandler = (id) => admin("PUT", "/v1/admin/settings/whatsapp", { defaultHandlerId: id });
  const customerOf = async (digits) => (await DB.prepare("SELECT id FROM customers WHERE phone_key = ?").bind(digits.slice(-10)).first());
  const handlersOf = async (customerId) => (await DB.prepare("SELECT employee_id FROM customer_employees WHERE customer_id = ?").bind(customerId).all()).results.map((row) => row.employee_id);
  const activity = async (action) => (await DB.prepare("SELECT * FROM activity_log WHERE category = 'customer' AND action = ? ORDER BY occurred_at").bind(action).all()).results;
  return { DB, env, request, admin, devices, people: { alice, boss, bob }, hook, setHandler, customerOf, handlersOf, activity };
}

test("a new number goes to the default handler, with one push and an activity row", async (t) => {
  const pushes = stubFetch(t);
  const f = await fixture(t);
  const saved = await f.setHandler(f.people.alice.id);
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).settings.whatsapp.defaultHandler, { id: f.people.alice.id, name: "Alice", active: true });
  const before = (await f.DB.prepare("SELECT value FROM whatsapp_settings WHERE key = 'feed_version'").first()).value;

  assert.equal((await f.hook("919811100001", "wamid.DH1")).status, 200);
  const customer = await f.customerOf("919811100001");
  assert.deepEqual(await f.handlersOf(customer.id), [f.people.alice.id]);
  const row = await f.DB.prepare("SELECT source, created_by_employee_id FROM customers WHERE id = ?").bind(customer.id).first();
  assert.deepEqual([row.source, row.created_by_employee_id], ["whatsapp", null]);

  // One push to Alice for the first message, in the new-message wording; nothing for Bob or the manager.
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].token, "fcm-token-Alice".padEnd(40, "x"));
  assert.deepEqual([pushes[0].data.type, pushes[0].data.customerId], ["message", customer.id]);

  const [assigned] = await f.activity("assigned");
  assert.deepEqual([assigned.actor_type, assigned.channel, assigned.target_id], ["system", "system", customer.id]);
  assert.deepEqual(JSON.parse(assigned.details), { employees: ["Alice"], auto: true, source: "default_handler" });
  assert.equal(JSON.parse((await f.activity("created"))[0].details).assigned, 1);

  // The chat is Alice's: unread and the shared feed move like for any assigned customer.
  assert.ok(Number((await f.DB.prepare("SELECT value FROM whatsapp_settings WHERE key = 'feed_version'").first()).value) > Number(before));
  const unread = await (await f.request("/v1/device/whatsapp/unread", { headers: { Authorization: `Bearer ${f.devices.Alice.deviceToken}` } })).json();
  assert.deepEqual([unread.chats, unread.messages], [1, 1]);
  const bobUnread = await (await f.request("/v1/device/whatsapp/unread", { headers: { Authorization: `Bearer ${f.devices.Bob.deviceToken}` } })).json();
  assert.equal(bobUnread.chats, 0);

  // Meta redelivers the same webhook: no second assignment, push or activity row.
  assert.equal((await f.hook("919811100001", "wamid.DH1")).status, 200);
  assert.deepEqual(await f.handlersOf(customer.id), [f.people.alice.id]);
  assert.equal(pushes.length, 1);
  assert.equal((await f.activity("assigned")).length, 1);
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM whatsapp_messages").first()).n, 1);
});

test("a manager can be the default handler", async (t) => {
  stubFetch(t);
  const f = await fixture(t);
  assert.equal((await f.setHandler(f.people.boss.id)).status, 200);
  await f.hook("919811100002", "wamid.DH2");
  assert.deepEqual(await f.handlersOf((await f.customerOf("919811100002")).id), [f.people.boss.id]);
});

test("without a default the customer stays unassigned as before, and clearing the setting restores that", async (t) => {
  const pushes = stubFetch(t);
  const f = await fixture(t);
  await f.hook("919811100003", "wamid.DH3");
  assert.deepEqual(await f.handlersOf((await f.customerOf("919811100003")).id), []);
  assert.equal((await f.activity("assigned")).length, 0);
  assert.equal(pushes.length, 0);

  await f.setHandler(f.people.alice.id);
  const cleared = await f.setHandler(null);
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).settings.whatsapp.defaultHandler, null);
  assert.equal(await f.DB.prepare("SELECT 1 AS x FROM app_settings WHERE key = ?").bind(key).first(), null);
  await f.hook("919811100004", "wamid.DH4");
  assert.deepEqual(await f.handlersOf((await f.customerOf("919811100004")).id), []);
});

test("an inactive default handler leaves the customer unassigned and the message stored", async (t) => {
  const pushes = stubFetch(t);
  const f = await fixture(t);
  await f.setHandler(f.people.bob.id);
  await createIdentityRepository(f.DB, tokenSecret).setEmployeeActive(f.people.bob.id, false);
  const settings = await (await f.admin("GET", "/v1/admin/settings")).json();
  assert.deepEqual(settings.settings.whatsapp.defaultHandler, { id: f.people.bob.id, name: "Bob", active: false });

  assert.equal((await f.hook("919811100005", "wamid.DH5")).status, 200);
  const customer = await f.customerOf("919811100005");
  assert.deepEqual(await f.handlersOf(customer.id), []);
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM whatsapp_messages WHERE customer_id = ?").bind(customer.id).first()).n, 1);
  assert.equal((await f.activity("assigned")).length, 0);
  assert.equal(pushes.length, 0);
  // A handler that no longer exists at all behaves the same.
  await f.DB.prepare("INSERT OR REPLACE INTO app_settings (key, value, encrypted, updated_at) VALUES (?, 'emp_gone', 0, '2026-01-01T00:00:00.000Z')").bind(key).run();
  assert.equal((await f.hook("919811100006", "wamid.DH6")).status, 200);
  assert.deepEqual(await f.handlersOf((await f.customerOf("919811100006")).id), []);
  assert.equal((await (await f.admin("GET", "/v1/admin/settings")).json()).settings.whatsapp.defaultHandler, null);
});

test("existing customers are never reassigned; an archived number is a new customer", async (t) => {
  const pushes = stubFetch(t);
  const f = await fixture(t);
  const loose = (await (await f.admin("POST", "/v1/admin/customers", { name: "Loose", phone: "9811100007" })).json()).customer;
  const owned = (await (await f.admin("POST", "/v1/admin/customers", { name: "Owned", phone: "9811100008", employeeIds: [f.people.bob.id] })).json()).customer;
  const gone = (await (await f.admin("POST", "/v1/admin/customers", { name: "Gone", phone: "9811100009" })).json()).customer;
  assert.equal((await f.admin("DELETE", `/v1/admin/customers/${gone.id}`)).status, 200);
  await f.setHandler(f.people.alice.id);
  pushes.length = 0; // creating "Owned" announced the assignment to Bob

  await f.hook("919811100007", "wamid.DH7");
  await f.hook("919811100008", "wamid.DH8");
  assert.deepEqual(await f.handlersOf(loose.id), []);
  assert.deepEqual(await f.handlersOf(owned.id), [f.people.bob.id]);
  assert.equal((await f.activity("assigned")).length, 0);
  assert.deepEqual(pushes.map((p) => p.token), ["fcm-token-Bob".padEnd(40, "x")]);

  // An archived customer is left alone. The number counts as new (as before the setting existed: a fresh customer is created), so it goes to the default handler.
  const archived = await f.hook("919811100009", "wamid.DH9");
  assert.equal(archived.status, 200);
  assert.deepEqual(await f.handlersOf(gone.id), []);
  const fresh = await f.DB.prepare("SELECT id FROM customers WHERE phone_key = '9811100009' AND archived_at IS NULL").first();
  assert.notEqual(fresh.id, gone.id);
  assert.deepEqual(await f.handlersOf(fresh.id), [f.people.alice.id]);
});

test("only an existing active employee can be the default handler", async (t) => {
  stubFetch(t);
  const f = await fixture(t);
  await createIdentityRepository(f.DB, tokenSecret).setEmployeeActive(f.people.bob.id, false);
  for (const id of ["emp_does_not_exist", f.people.bob.id]) {
    const refused = await f.setHandler(id);
    assert.equal(refused.status, 400, id);
    assert.equal((await refused.json()).error.code, "invalid_employee");
  }
  for (const body of [{ defaultHandlerId: "" }, { defaultHandlerId: 7 }, { defaultHandlerId: ["x"] }]) {
    assert.equal((await f.admin("PUT", "/v1/admin/settings/whatsapp", body)).status, 400, JSON.stringify(body));
  }
  assert.equal(await f.DB.prepare("SELECT 1 AS x FROM app_settings WHERE key = ?").bind(key).first(), null);
  assert.equal((await f.setHandler(f.people.alice.id)).status, 200);
  // Saving the other WhatsApp settings does not touch it, and it is not a deployment variable to import.
  assert.equal((await f.admin("PUT", "/v1/admin/settings/whatsapp", { appId: "1234567890" })).status, 200);
  assert.equal((await f.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first()).value, f.people.alice.id);
  const read = await (await f.admin("GET", "/v1/admin/settings")).json();
  assert.ok(!read.deployment.importable.includes(key));
});

test("the setting needs an administrator; employees cannot read or change it", async (t) => {
  stubFetch(t);
  const f = await fixture(t);
  assert.equal((await f.request("/v1/admin/settings")).status, 401);
  assert.equal((await f.request("/v1/admin/settings/whatsapp", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ defaultHandlerId: f.people.alice.id }) })).status, 401);
  for (const [name, device] of Object.entries(f.devices)) {
    const headers = { Authorization: `Bearer ${device.deviceToken}`, "Content-Type": "application/json" };
    assert.equal((await f.request("/v1/admin/settings", { headers })).status, 401, name);
    assert.equal((await f.request("/v1/admin/settings/whatsapp", { method: "PUT", headers, body: JSON.stringify({ defaultHandlerId: device.employee?.id ?? f.people.alice.id }) })).status, 401, name);
  }
  assert.equal(await f.DB.prepare("SELECT 1 AS x FROM app_settings WHERE key = ?").bind(key).first(), null);
});
