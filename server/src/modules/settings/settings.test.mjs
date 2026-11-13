import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { unstable_splitSqlQuery } from "wrangler";

import { createDatabase, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { createIdentityRepository } = await loadModule("./identity.ts");
const adminSecret = "synthetic-settings-admin-secret-not-for-deployment";
const tokenSecret = "synthetic-settings-token-secret-not-for-deployment";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccount = (projectId = "linekeep-test") => JSON.stringify({
  client_email: `push@${projectId}.iam.gserviceaccount.com`, project_id: projectId,
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});
const clientConfig = (projectId = "linekeep-test") => ({
  apiKey: "synthetic-firebase-api-key-for-tests", appId: "1:123456789012:android:abcdef0123456789", projectId, senderId: "123456789012",
});
const secrets = {
  token: "EAAsyntheticwhatsapptokenvalue", appSecret: "syntheticappsecretvalue0123456789", verifyToken: "synthetic-verify-token",
  apiKey: "synthetic-mailgun-api-key",
};

async function fixture(t, extraEnv = {}) {
  const DB = await createDatabase(t);
  const env = { DB, TOKEN_HASH_SECRET: tokenSecret, LOCAL_ADMIN_SECRET: adminSecret, ENVIRONMENT: "development", ...extraEnv };
  const app = createApp();
  const request = (path, init = {}) => app.request(new URL(path, "http://127.0.0.1"), init, env);
  const admin = (method, path, body) => request(path, {
    method, headers: { Authorization: `Bearer ${adminSecret}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const put = (section, body) => admin("PUT", `/v1/admin/settings/${section}`, body);
  const get = async () => (await admin("GET", "/v1/admin/settings")).json();
  const raw = (key) => DB.prepare("SELECT value, encrypted FROM app_settings WHERE key = ?").bind(key).first();
  return { DB, env, request, admin, put, get, raw };
}

function stubFetch(t, handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test("settings need an administrator", async (t) => {
  const f = await fixture(t);
  for (const [method, path] of [["GET", "/v1/admin/settings"], ["PUT", "/v1/admin/settings/whatsapp"], ["GET", "/v1/admin/features"],
    ["POST", "/v1/admin/settings/import-deployment"], ["POST", "/v1/admin/settings/whatsapp/test"], ["POST", "/v1/admin/settings/email/test"]]) {
    assert.equal((await f.request(path, { method })).status, 401, path);
  }
});

test("a fresh install has everything off and unset", async (t) => {
  const f = await fixture(t);
  const body = await f.get();
  assert.deepEqual(body.settings.features, { customers: false, whatsapp: false });
  assert.deepEqual(body.settings.whatsapp, {
    phoneNumberId: null, wabaId: null, appId: null, graphVersion: "v23.0", defaultHandler: null,
    token: { set: false, source: "none", hint: null }, appSecret: { set: false, source: "none", hint: null }, verifyToken: { set: false, source: "none", hint: null },
  });
  assert.deepEqual(body.settings.email, {
    enabled: false, domain: null, fromEmail: null, region: "us", recipients: [], sendTime: "18:00",
    apiKey: { set: false, source: "none", hint: null }, lastSent: null,
  });
  assert.deepEqual(body.settings.push, { clientConfig: null, serviceAccount: { set: false, source: "none", hint: null, projectId: null } });
  assert.deepEqual(body.deployment, { importable: [] });
  const features = await (await f.admin("GET", "/v1/admin/features")).json();
  assert.deepEqual([features.customers, features.whatsapp], [false, false]);
});

test("updates are partial, secrets are write-only and encrypted at rest, and null clears", async (t) => {
  const f = await fixture(t);
  const first = await f.put("whatsapp", {
    token: secrets.token, appSecret: secrets.appSecret, verifyToken: secrets.verifyToken, phoneNumberId: "1000000000000001", graphVersion: "v24.0",
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.deepEqual(Object.keys(firstBody.settings), ["whatsapp"]);
  assert.deepEqual(firstBody.settings.whatsapp.token, { set: true, source: "database", hint: "EAA••••lue" });
  assert.equal(firstBody.settings.whatsapp.phoneNumberId, "1000000000000001");
  assert.equal(firstBody.generatedVerifyToken, undefined);

  // Absent fields are unchanged.
  await f.put("whatsapp", { wabaId: "1000000000000002" });
  const after = await f.get();
  assert.equal(after.settings.whatsapp.wabaId, "1000000000000002");
  assert.equal(after.settings.whatsapp.phoneNumberId, "1000000000000001");
  assert.equal(after.settings.whatsapp.graphVersion, "v24.0");
  assert.deepEqual(after.settings.whatsapp.token, { set: true, source: "database", hint: "EAA••••lue" });

  // No secret value appears in any response, and the database holds ciphertext.
  const everything = JSON.stringify([firstBody, after, await (await f.admin("GET", "/v1/admin/features")).json()]);
  for (const value of Object.values(secrets)) assert.ok(!everything.includes(value));
  for (const key of ["token", "appSecret", "verifyToken"]) {
    const stored = await f.raw(`whatsapp.${key}`);
    assert.equal(stored.encrypted, 1);
    assert.ok(!stored.value.includes(secrets[key]));
  }
  assert.deepEqual(await f.raw("whatsapp.phoneNumberId"), { value: "1000000000000001", encrypted: 0 });

  // Replacing a secret re-encrypts; null clears.
  const before = (await f.raw("whatsapp.token")).value;
  await f.put("whatsapp", { token: `${secrets.token}2` });
  assert.notEqual((await f.raw("whatsapp.token")).value, before);
  await f.put("whatsapp", { token: null, wabaId: null });
  const cleared = await f.get();
  assert.deepEqual(cleared.settings.whatsapp.token, { set: false, source: "none", hint: null });
  assert.equal(cleared.settings.whatsapp.wabaId, null);
  assert.equal(await f.raw("whatsapp.token"), null);
});

test("a generated verify token is returned once and never again", async (t) => {
  const f = await fixture(t);
  const body = await (await f.put("whatsapp", { verifyToken: { generate: true } })).json();
  assert.match(body.generatedVerifyToken, /^[0-9a-f]{48}$/);
  assert.deepEqual(body.settings.whatsapp.verifyToken, { set: true, source: "database", hint: `${body.generatedVerifyToken.slice(0, 3)}••••${body.generatedVerifyToken.slice(-3)}` });
  assert.ok(!JSON.stringify(await f.get()).includes(body.generatedVerifyToken));
  assert.ok(!(await f.raw("whatsapp.verifyToken")).value.includes(body.generatedVerifyToken));
  const second = await (await f.put("whatsapp", { verifyToken: { generate: true } })).json();
  assert.notEqual(second.generatedVerifyToken, body.generatedVerifyToken);
});

test("input is validated and nothing is stored when any field is wrong", async (t) => {
  const f = await fixture(t);
  const bad = [
    ["whatsapp", { phoneNumberId: "12ab" }], ["whatsapp", { wabaId: "123" }], ["whatsapp", { appId: "x".repeat(40) }],
    ["whatsapp", { graphVersion: "23" }], ["whatsapp", { token: "has space in it" }], ["whatsapp", { token: 12 }],
    ["whatsapp", { verifyToken: { generate: false } }], ["whatsapp", { unknown: "x" }],
    ["email", { fromEmail: "not-an-email" }], ["email", { recipients: ["ok@example.com", "nope"] }], ["email", { recipients: "a@example.com" }],
    ["email", { sendTime: "25:00" }], ["email", { sendTime: "6pm" }], ["email", { region: "asia" }], ["email", { domain: "localhost" }],
    ["email", { enabled: "yes" }],
    ["push", { serviceAccount: "not json" }], ["push", { serviceAccount: JSON.stringify({ project_id: "x" }) }],
    ["push", { clientConfig: { apiKey: "short" } }], ["push", { clientConfig: { ...clientConfig(), extra: 1 } }],
    ["features", { customers: "true" }],
  ];
  for (const [section, body] of bad) {
    const response = await f.put(section, body);
    assert.equal(response.status, 400, `${section} ${JSON.stringify(body)}`);
    assert.equal((await response.json()).error.code, "INVALID_REQUEST");
  }
  // One bad field rejects the whole request.
  assert.equal((await f.put("whatsapp", { wabaId: "1000000000000002", phoneNumberId: "bad" })).status, 400);
  assert.equal(await f.raw("whatsapp.wabaId"), null);
  assert.equal((await f.put("nope", {})).status, 404);
  // Error messages name the field but never echo the submitted value.
  const echoed = await (await f.put("whatsapp", { token: "bad value with spaces" })).text();
  assert.ok(echoed.includes("whatsapp.token") && !echoed.includes("bad value"));
});

test("email settings: recipients, send time, region and the last-sent state", async (t) => {
  const f = await fixture(t);
  const body = await (await f.put("email", {
    enabled: true, apiKey: secrets.apiKey, domain: "mg.example.com", fromEmail: "reports@mg.example.com", region: "eu",
    recipients: ["a@example.com", "b@example.com", "a@example.com"], sendTime: "09:30",
  })).json();
  assert.deepEqual({ ...body.settings.email, lastSent: undefined }, {
    enabled: true, domain: "mg.example.com", fromEmail: "reports@mg.example.com", region: "eu",
    recipients: ["a@example.com", "b@example.com"], sendTime: "09:30", apiKey: { set: true, source: "database", hint: "syn••••key" }, lastSent: undefined,
  });
  await f.DB.prepare("INSERT INTO app_settings (key, value, encrypted, updated_at) VALUES ('job.email.lastSent', ?, 0, 'x')")
    .bind(JSON.stringify({ date: "2026-09-28", status: "sent" })).run();
  assert.deepEqual((await f.get()).settings.email.lastSent, { date: "2026-09-28", status: "sent" });
  assert.ok(!JSON.stringify(await f.get()).includes(secrets.apiKey));
});

test("push settings require a valid key and a matching Firebase project", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.put("push", { clientConfig: clientConfig("linekeep-test") })).status, 200);
  const mismatch = await f.put("push", { serviceAccount: serviceAccount("other-project") });
  assert.equal(mismatch.status, 400);
  assert.equal(await f.raw("push.serviceAccount"), null);
  const saved = await (await f.put("push", { serviceAccount: serviceAccount("linekeep-test") })).json();
  assert.deepEqual(saved.settings.push.serviceAccount, { set: true, source: "database", hint: null, projectId: "linekeep-test" });
  assert.deepEqual(saved.settings.push.clientConfig, clientConfig("linekeep-test"));
  const stored = await f.raw("push.serviceAccount");
  assert.equal(stored.encrypted, 1);
  assert.ok(!stored.value.includes("PRIVATE KEY") && !stored.value.includes("client_email"));
  assert.ok(!JSON.stringify(await f.get()).includes("PRIVATE KEY"));
  // Changing only the client config is checked against the stored key too.
  assert.equal((await f.put("push", { clientConfig: clientConfig("other-project") })).status, 400);
});

test("the database wins over deployment variables, which stay as the fallback", async (t) => {
  const f = await fixture(t, {
    WHATSAPP_TOKEN: "deployment-token-value", WHATSAPP_PHONE_NUMBER_ID: "2000000000000001", WHATSAPP_WABA_ID: "2000000000000002",
    MAILGUN_DOMAIN: "env.example.com", EMAIL_IDS: "env@example.com", CALL_SUMMARY_ENABLED: "true",
  });
  const before = await f.get();
  assert.deepEqual(before.settings.whatsapp.token, { set: true, source: "deployment", hint: "dep••••lue" });
  assert.equal(before.settings.whatsapp.phoneNumberId, "2000000000000001");
  assert.deepEqual(before.settings.email.recipients, ["env@example.com"]);
  assert.equal(before.settings.email.enabled, true);
  assert.ok(!JSON.stringify(before).includes("deployment-token-value"));

  await f.put("whatsapp", { token: secrets.token, phoneNumberId: "1000000000000001" });
  await f.put("email", { enabled: false, domain: "db.example.com" });
  const after = await f.get();
  assert.deepEqual(after.settings.whatsapp.token, { set: true, source: "database", hint: "EAA••••lue" });
  assert.equal(after.settings.whatsapp.phoneNumberId, "1000000000000001");
  assert.equal(after.settings.whatsapp.wabaId, "2000000000000002"); // untouched: still the deployment value
  assert.equal(after.settings.email.enabled, false);
  assert.equal(after.settings.email.domain, "db.example.com");

  // Clearing falls back to the deployment value.
  await f.put("whatsapp", { token: null, phoneNumberId: null });
  const cleared = await f.get();
  assert.deepEqual(cleared.settings.whatsapp.token, { set: true, source: "deployment", hint: "dep••••lue" });
  assert.equal(cleared.settings.whatsapp.phoneNumberId, "2000000000000001");
});

test("dashboard settings reach the code that sends WhatsApp, push and email", async (t) => {
  const f = await fixture(t);
  const identity = createIdentityRepository(f.DB, tokenSecret);
  const employee = await identity.createEmployee({ name: "Asha" });
  const device = await identity.redeemInvitation((await identity.createInvitation(employee.id, "2099-01-01T00:00:00Z")).invitationCode, { model: "Synthetic" });
  const deviceGet = (path) => f.request(path, { headers: { Authorization: `Bearer ${device.deviceToken}` } });
  await f.put("features", { customers: true, whatsapp: true });
  assert.equal((await (await f.admin("GET", "/v1/admin/whatsapp/status")).json()).canSend, false);
  assert.equal((await (await deviceGet("/v1/device/push-config")).json()).push, null);
  await f.put("whatsapp", { token: secrets.token, phoneNumberId: "1000000000000001" });
  await f.put("push", { clientConfig: clientConfig() });
  // Both requests are served by the isolate that handled the write, so the cached settings were dropped on save.
  assert.equal((await (await f.admin("GET", "/v1/admin/whatsapp/status")).json()).canSend, true);
  assert.deepEqual((await (await deviceGet("/v1/device/push-config")).json()).push, clientConfig());
});

test("importing deployment values copies them into the encrypted store once", async (t) => {
  const f = await fixture(t, {
    WHATSAPP_TOKEN: secrets.token, WHATSAPP_PHONE_NUMBER_ID: "2000000000000001", WHATSAPP_GRAPH_VERSION: "bad",
    FCM_SERVICE_ACCOUNT: serviceAccount(), FIREBASE_CLIENT_CONFIG: JSON.stringify(clientConfig()),
    MAILGUN_API_KEY: secrets.apiKey, EMAIL_IDS: "a@example.com,b@example.com", CALL_SUMMARY_ENABLED: "false",
  });
  await f.put("whatsapp", { phoneNumberId: "1000000000000001" });
  const importable = (await f.get()).deployment.importable;
  assert.deepEqual([...importable].sort(), ["email.apiKey", "email.recipients", "push.clientConfig", "push.serviceAccount", "whatsapp.token"]);
  const response = await f.admin("POST", "/v1/admin/settings/import-deployment");
  assert.equal(response.status, 200);
  assert.deepEqual([...(await response.json()).imported].sort(), [...importable].sort());
  assert.equal((await f.raw("whatsapp.token")).encrypted, 1);
  assert.ok(!(await f.raw("whatsapp.token")).value.includes(secrets.token));
  assert.equal((await f.raw("whatsapp.phoneNumberId")).value, "1000000000000001"); // not overwritten
  assert.equal(await f.raw("whatsapp.graphVersion"), null); // invalid values are not imported
  const after = await f.get();
  assert.deepEqual(after.deployment.importable, []);
  assert.deepEqual(after.settings.whatsapp.token, { set: true, source: "database", hint: "EAA••••lue" });
  assert.deepEqual(after.settings.email.recipients, ["a@example.com", "b@example.com"]);
  assert.deepEqual((await (await f.admin("POST", "/v1/admin/settings/import-deployment")).json()).imported, []);
});

test("secrets cannot be saved without TOKEN_HASH_SECRET, but plain values and clearing still work", async (t) => {
  const f = await fixture(t, { TOKEN_HASH_SECRET: undefined, WHATSAPP_TOKEN: secrets.token });
  const refused = await f.put("whatsapp", { token: secrets.token, phoneNumberId: "1000000000000001" });
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).error.message, /TOKEN_HASH_SECRET/);
  assert.equal(await f.raw("whatsapp.phoneNumberId"), null); // all or nothing
  assert.equal((await f.put("whatsapp", { phoneNumberId: "1000000000000001", token: null })).status, 200);
  assert.equal((await f.admin("POST", "/v1/admin/settings/import-deployment")).status, 503);
  const generated = await f.put("whatsapp", { verifyToken: { generate: true } });
  assert.equal(generated.status, 503);
});

test("WhatsApp test reaches Graph with the stored token and never reports it", async (t) => {
  const f = await fixture(t);
  const { requestId, ...unset } = await (await f.admin("POST", "/v1/admin/settings/whatsapp/test")).json();
  assert.ok(requestId);
  assert.deepEqual(unset, { ok: false, error: "Save the access token and the phone number id first." });
  await f.put("whatsapp", { token: secrets.token, phoneNumberId: "1000000000000001" });
  let answer = () => Response.json({ display_phone_number: "+1 555 010 0000", verified_name: "Synthetic Shop" });
  const calls = stubFetch(t, () => answer());
  const ok = await (await f.admin("POST", "/v1/admin/settings/whatsapp/test")).json();
  assert.equal(ok.ok, true);
  assert.equal(ok.displayPhoneNumber, "+1 555 010 0000");
  assert.equal(ok.verifiedName, "Synthetic Shop");
  assert.ok(calls[0].url.startsWith("https://graph.facebook.com/v23.0/1000000000000001"));
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${secrets.token}`);

  answer = () => Response.json({ error: { code: 190, message: `Invalid OAuth access token ${secrets.token}` } }, { status: 401 });
  const rejected = await (await f.admin("POST", "/v1/admin/settings/whatsapp/test")).text();
  assert.ok(rejected.includes('"ok":false') && !rejected.includes(secrets.token));
  answer = () => { throw new Error(`network down ${secrets.token}`); };
  const down = await (await f.admin("POST", "/v1/admin/settings/whatsapp/test")).text();
  assert.ok(down.includes('"ok":false') && !down.includes(secrets.token));
});

test("email test sends to the configured recipients and reports failures without secrets", async (t) => {
  const f = await fixture(t);
  const unset = await (await f.admin("POST", "/v1/admin/settings/email/test")).json();
  assert.equal(unset.ok, false);
  assert.match(unset.error, /recipients/);
  await f.put("email", { apiKey: secrets.apiKey, domain: "mg.example.com", recipients: ["a@example.com", "b@example.com"] });
  let status = 200;
  const calls = stubFetch(t, () => new Response("{}", { status }));
  const sent = await (await f.admin("POST", "/v1/admin/settings/email/test")).json();
  assert.equal(sent.ok, true);
  assert.equal(calls.length, 1);
  const form = calls[0].init.body;
  assert.deepEqual(form.getAll("to"), ["a@example.com", "b@example.com"]);
  assert.equal(calls[0].url, "https://api.mailgun.net/v3/mg.example.com/messages");
  status = 401;
  const rejected = await (await f.admin("POST", "/v1/admin/settings/email/test")).text();
  assert.ok(rejected.includes('"ok":false') && !rejected.includes(secrets.apiKey));
  // A test message does not count as the day's summary.
  assert.equal(await f.raw("job.email.lastSent"), null);
});

test("Customers and WhatsApp are off until switched on, then gate their routes", async (t) => {
  const f = await fixture(t);
  const identity = createIdentityRepository(f.DB, tokenSecret);
  const employee = await identity.createEmployee({ name: "Asha" });
  const device = await identity.redeemInvitation((await identity.createInvitation(employee.id, "2099-01-01T00:00:00Z")).invitationCode, { model: "Synthetic" });
  const asDevice = (path) => f.request(path, { headers: { Authorization: `Bearer ${device.deviceToken}` } });
  const adminPaths = ["/v1/admin/customers", "/v1/admin/whatsapp/status", "/v1/admin/whatsapp/chats", "/v1/admin/whatsapp/auto-replies", "/v1/admin/whatsapp/quick-messages"];
  const devicePaths = ["/v1/device/customers", "/v1/device/whatsapp/chats", "/v1/device/whatsapp/quick-messages", "/v1/device/whatsapp/status"];
  const expectOff = async (paths, call) => {
    for (const path of paths) {
      const response = await call(path);
      assert.equal(response.status, 404, path);
      assert.equal((await response.json()).error.code, "feature_disabled", path);
    }
  };
  await expectOff(adminPaths, (path) => f.admin("GET", path));
  await expectOff(devicePaths, asDevice);
  // Only signed-in callers learn about the feature: a bad credential is still a 401.
  assert.equal((await f.request("/v1/admin/customers")).status, 401);
  assert.equal((await f.request("/v1/device/customers", { headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await f.request("/v1/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=1&hub.verify_token=x")).status, 404);
  assert.equal((await f.request("/v1/webhooks/whatsapp", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status, 404);
  // Push registration is not a customers feature.
  assert.equal((await f.request("/v1/device/push-config", { headers: { Authorization: `Bearer ${device.deviceToken}` } })).status, 200);

  assert.equal((await f.put("features", { whatsapp: true })).status, 400); // needs Customers
  assert.equal((await f.put("features", { customers: false, whatsapp: true })).status, 400);
  assert.equal((await f.put("features", { customers: true })).status, 200);
  const features = await (await f.admin("GET", "/v1/admin/features")).json();
  assert.deepEqual([features.customers, features.whatsapp], [true, false]);
  assert.equal((await f.admin("GET", "/v1/admin/customers")).status, 200);
  assert.equal((await asDevice("/v1/device/customers")).status, 200);
  await expectOff(adminPaths.slice(1), (path) => f.admin("GET", path));
  await expectOff(devicePaths.slice(1), asDevice);

  assert.equal((await f.put("features", { whatsapp: true })).status, 200);
  for (const path of adminPaths) assert.equal((await f.admin("GET", path)).status, 200, path);
  for (const path of devicePaths) assert.equal((await asDevice(path)).status, 200, path);
  assert.equal((await f.request("/v1/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=1&hub.verify_token=x")).status, 403); // reachable, token unset

  // Turning Customers off while WhatsApp is on is refused; the other order works.
  assert.equal((await f.put("features", { customers: false })).status, 400);
  assert.equal((await f.put("features", { whatsapp: false })).status, 200);
  assert.equal((await f.put("features", { customers: false })).status, 200);
  assert.equal((await f.admin("GET", "/v1/admin/customers")).status, 404);
});

test("an install already configured through WhatsApp variables keeps WhatsApp on until switched off", async (t) => {
  const f = await fixture(t, { WHATSAPP_TOKEN: secrets.token, WHATSAPP_PHONE_NUMBER_ID: "2000000000000001" });
  const features = await (await f.admin("GET", "/v1/admin/features")).json();
  assert.deepEqual([features.customers, features.whatsapp], [true, true]);
  assert.equal((await f.admin("GET", "/v1/admin/customers")).status, 200);
  await f.put("features", { whatsapp: false });
  assert.equal((await f.admin("GET", "/v1/admin/whatsapp/status")).status, 404);
  assert.equal((await f.admin("GET", "/v1/admin/customers")).status, 200);
});

test("migration 0017 switches features on only where the data already exists", async (t) => {
  const migration = unstable_splitSqlQuery(await readFile(new URL("../../../migrations/0017_settings.sql", import.meta.url), "utf8"));
  const run = async (db) => db.batch(migration.map((statement) => db.prepare(statement)));
  const keys = async (db) => (await db.prepare("SELECT key FROM app_settings ORDER BY key").all()).results.map((row) => row.key);

  const empty = await createDatabase(t, "0016_push_tokens.sql");
  await run(empty);
  assert.deepEqual(await keys(empty), []);

  const withCustomers = await createDatabase(t, "0016_push_tokens.sql");
  await withCustomers.prepare("INSERT INTO customers (id, name, phone, phone_key, created_at, updated_at) VALUES ('cus_1', 'Synthetic', '+919876543210', '9876543210', 'x', 'x')").run();
  await run(withCustomers);
  assert.deepEqual(await keys(withCustomers), ["feature.customers"]);

  const withQuickMessage = await createDatabase(t, "0016_push_tokens.sql");
  await withQuickMessage.prepare("INSERT INTO whatsapp_quick_messages (id, title, text, created_at, updated_at) VALUES ('wqm_1', 'Hi', 'Hello', 'x', 'x')").run();
  await run(withQuickMessage);
  assert.deepEqual(await keys(withQuickMessage), ["feature.customers", "feature.whatsapp"]);
});
