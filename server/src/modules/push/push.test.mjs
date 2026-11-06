import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createDatabase, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { createIdentityRepository } = await loadModule("./identity.ts");
const { createCustomerRepository } = await loadModule("./customers.ts");
const adminSecret = "synthetic-push-admin-secret-not-for-deployment";
const tokenSecret = "synthetic-push-token-secret-not-for-deployment";
const appSecret = "synthetic-app-secret";
const phoneNumberId = "1000000000000001";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccount = JSON.stringify({
  client_email: "push@linekeep-test.iam.gserviceaccount.com", project_id: "linekeep-test",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});
const whatsapp = {
  WHATSAPP_TOKEN: "synthetic-token", WHATSAPP_PHONE_NUMBER_ID: phoneNumberId, WHATSAPP_APP_SECRET: appSecret, WHATSAPP_VERIFY_TOKEN: "v",
};
const fcmToken = (name) => `fcm-token-${name}`.padEnd(40, "x");

async function fixture(t, extraEnv = { FCM_SERVICE_ACCOUNT: serviceAccount }) {
  const DB = await createDatabase(t);
  const identity = createIdentityRepository(DB, tokenSecret);
  const people = {};
  for (const name of ["Alice", "Bob", "Carol"]) {
    const employee = await identity.createEmployee({ name });
    const enrolled = await identity.redeemInvitation((await identity.createInvitation(employee.id, "2099-01-01T00:00:00Z")).invitationCode, { model: "Synthetic" });
    people[name] = { employee, enrolled };
  }
  const env = { DB, TOKEN_HASH_SECRET: tokenSecret, LOCAL_ADMIN_SECRET: adminSecret, ENVIRONMENT: "development", ...whatsapp, ...extraEnv };
  const app = createApp();
  const request = (path, init = {}) => app.request(new URL(path, "http://127.0.0.1"), init, env);
  const admin = (method, path, body) => request(path, { method, headers: { Authorization: `Bearer ${adminSecret}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const register = (name, token) => request("/v1/device/push-token", { method: "PUT", headers: { Authorization: `Bearer ${people[name].enrolled.deviceToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ token: token ?? fcmToken(name) }) });
  const customers = createCustomerRepository(DB);
  const hook = (from, id, body = "hello") => {
    const raw = JSON.stringify({ entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId },
      messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }] } }] }] });
    return request("/v1/webhooks/whatsapp", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=" + createHmac("sha256", appSecret).update(raw).digest("hex") }, body: raw });
  };
  return { DB, people, request, admin, register, customers, hook };
}

/** Captures what is sent to FCM; `answer(token)` can make a token fail. */
function stubFcm(t, answer = () => new Response("{}", { status: 200 })) {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://oauth2.googleapis.com/")) return new Response(JSON.stringify({ access_token: "synthetic-access", expires_in: 3600 }), { status: 200 });
    if (u.startsWith("https://fcm.googleapis.com/")) {
      const message = JSON.parse(init.body).message;
      sent.push({ token: message.token, data: message.data, android: message.android, auth: init.headers.Authorization });
      return answer(message.token);
    }
    throw new Error("unexpected fetch " + u);
  };
  t.after(() => { globalThis.fetch = original; });
  return sent;
}
const tokensOf = (sent) => sent.map((entry) => entry.token).sort();

test("a phone registers, replaces and removes its token; bad input is refused", async (t) => {
  const f = await fixture(t);
  const auth = { Authorization: `Bearer ${f.people.Alice.enrolled.deviceToken}`, "Content-Type": "application/json" };
  assert.equal((await f.register("Alice")).status, 200);
  assert.equal((await f.register("Alice", fcmToken("alice-new"))).status, 200);
  assert.deepEqual((await f.DB.prepare("SELECT token FROM device_push_tokens").all()).results.map((r) => r.token), [fcmToken("alice-new")]);
  assert.equal((await f.request("/v1/device/push-token", { method: "PUT", headers: auth, body: JSON.stringify({ token: "short" }) })).status, 400);
  assert.equal((await f.request("/v1/device/push-token", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: fcmToken("x") }) })).status, 401);
  // The same token on another phone moves; two phones never share a registration.
  await f.register("Bob", fcmToken("alice-new"));
  assert.deepEqual((await f.DB.prepare("SELECT device_id FROM device_push_tokens").all()).results.length, 1);
  assert.equal((await f.request("/v1/device/push-token", { method: "DELETE", headers: { Authorization: `Bearer ${f.people.Bob.enrolled.deviceToken}` } })).status, 200);
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM device_push_tokens").first()).n, 0);
});

test("a customer's message notifies only the employees assigned to that customer, once", async (t) => {
  const f = await fixture(t);
  const sent = stubFcm(t);
  for (const name of ["Alice", "Bob", "Carol"]) await f.register(name);
  const shared = await f.customers.createCustomer({ name: "Asha Traders", phone: "9876543210", employeeIds: [f.people.Alice.employee.id, f.people.Bob.employee.id] });
  await f.customers.createCustomer({ name: "Nobody's", phone: "9123456780" });
  assert.ok(shared.id);

  assert.equal((await f.hook("919876543210", "wamid.1")).status, 200);
  assert.deepEqual(tokensOf(sent), [fcmToken("Alice"), fcmToken("Bob")]); // Carol is not assigned
  assert.deepEqual(sent[0].data, { type: "message", customerId: shared.id, customerName: "Asha Traders", title: "New WhatsApp message", body: "Asha Traders" });
  assert.equal(sent[0].android.priority, "HIGH");
  assert.equal(sent[0].auth, "Bearer synthetic-access");
  assert.ok(!JSON.stringify(sent).includes("hello")); // the message text never goes to Google

  await f.hook("919876543210", "wamid.1"); // Meta redelivers
  assert.equal(sent.length, 2);
  await f.hook("919123456780", "wamid.2"); // customer nobody handles
  assert.equal(sent.length, 2);
});

test("revoked phones, inactive employees and employees without a token get nothing", async (t) => {
  const f = await fixture(t);
  const sent = stubFcm(t);
  const customer = await f.customers.createCustomer({ name: "Buyer", phone: "9876543210", employeeIds: Object.values(f.people).map((p) => p.employee.id) });
  assert.ok(customer.id);
  await f.register("Alice"); await f.register("Bob");
  await f.DB.prepare("UPDATE devices SET revoked_at = '2026-01-01T00:00:00.000Z' WHERE employee_id = ?").bind(f.people.Alice.employee.id).run();
  await f.hook("919876543210", "wamid.A");
  assert.deepEqual(tokensOf(sent), [fcmToken("Bob")]); // Carol never registered
  await f.DB.prepare("UPDATE employees SET active = 0 WHERE id = ?").bind(f.people.Bob.employee.id).run();
  await f.hook("919876543210", "wamid.B");
  assert.equal(sent.length, 1);
});

test("newly assigned employees are notified; removed or unchanged ones are not", async (t) => {
  const f = await fixture(t);
  const sent = stubFcm(t);
  for (const name of ["Alice", "Bob"]) await f.register(name);
  const { Alice, Bob } = f.people;

  const created = await (await f.admin("POST", "/v1/admin/customers", { name: "New lead", phone: "9876543210", employeeIds: [Alice.employee.id] })).json();
  assert.deepEqual(sent.map((s) => [s.token, s.data.type, s.data.title]), [[fcmToken("Alice"), "assigned", "New customer assigned"]]);
  const id = created.customer.id;

  sent.length = 0;
  await f.admin("PUT", `/v1/admin/customers/${id}/employees`, { employeeIds: [Alice.employee.id, Bob.employee.id] });
  assert.deepEqual(tokensOf(sent), [fcmToken("Bob")]); // Alice already handled this customer

  sent.length = 0;
  await f.admin("PUT", `/v1/admin/customers/${id}/employees`, { employeeIds: [Bob.employee.id] });
  assert.equal(sent.length, 0); // removing Alice is silent
  await f.admin("PUT", `/v1/admin/customers/${id}/employees`, { employeeIds: [Bob.employee.id] });
  assert.equal(sent.length, 0); // saving the same set tells nobody
  await f.admin("PUT", `/v1/admin/customers/${id}/employees`, { employeeIds: [] });
  assert.equal(sent.length, 0);
});

test("a token FCM reports as unregistered is forgotten; other failures keep it", async (t) => {
  const f = await fixture(t);
  const sent = stubFcm(t, (token) => token === fcmToken("Alice")
    ? new Response(JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }), { status: 404 })
    : new Response("{}", { status: 500 }));
  await f.register("Alice"); await f.register("Bob");
  await f.customers.createCustomer({ name: "Buyer", phone: "9876543210", employeeIds: [f.people.Alice.employee.id, f.people.Bob.employee.id] });
  assert.equal((await f.hook("919876543210", "wamid.X")).status, 200); // a failing push never fails the webhook
  assert.equal(sent.length, 2);
  assert.deepEqual((await f.DB.prepare("SELECT token FROM device_push_tokens").all()).results.map((r) => r.token), [fcmToken("Bob")]);
});

test("without a service account nothing is sent and nothing breaks", async (t) => {
  const f = await fixture(t, {});
  const sent = stubFcm(t);
  await f.register("Alice");
  await f.customers.createCustomer({ name: "Buyer", phone: "9876543210", employeeIds: [f.people.Alice.employee.id] });
  assert.equal((await f.hook("919876543210", "wamid.N")).status, 200);
  await f.admin("POST", "/v1/admin/customers", { name: "Another", phone: "9123456780", employeeIds: [f.people.Alice.employee.id] });
  assert.equal(sent.length, 0);
});

test("phones learn the Firebase client identifiers from the server, and only when they are well-formed", async (t) => {
  const config = { apiKey: "AIzaSyExampleExampleExampleExample01", appId: "1:123456789012:android:abcdef0123456789abcdef", projectId: "linekeep-example", senderId: "123456789012" };
  const get = async (f) => (await f.request("/v1/device/push-config", { headers: { Authorization: `Bearer ${f.people.Alice.enrolled.deviceToken}` } })).json();
  const on = await fixture(t, { FIREBASE_CLIENT_CONFIG: JSON.stringify(config) });
  assert.deepEqual((await get(on)).push, config);
  assert.equal((await on.request("/v1/device/push-config")).status, 401);
  assert.equal((await get(await fixture(t, {}))).push, null);
  assert.equal((await get(await fixture(t, { FIREBASE_CLIENT_CONFIG: "not json" }))).push, null);
  assert.equal((await get(await fixture(t, { FIREBASE_CLIENT_CONFIG: JSON.stringify({ ...config, appId: "bad" }) }))).push, null);
  assert.equal((await get(await fixture(t, { FIREBASE_CLIENT_CONFIG: JSON.stringify({ ...config, extra: "x" }) }))).push, null);
});
