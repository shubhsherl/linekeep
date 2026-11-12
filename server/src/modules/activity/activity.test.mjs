import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { Miniflare } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";

import { createDatabase, enableFeatures, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { createIdentityRepository } = await loadModule("./identity.ts");
const { createCallRepository } = await loadModule("./calls.ts");
const { recordActivity, recordActivityBatch, recordMergedActivity, touchEmployeeActivity } = await loadModule("../activity/record.ts");
const { purgeExpiredActivity } = await loadModule("../retention/activity.ts");
const { csvCell } = await loadModule("./activity.ts");

const adminSecret = "synthetic-activity-admin-secret-not-for-deployment";
const tokenSecret = "synthetic-activity-token-secret-not-for-deployment";
const mail = { MAILGUN_API_KEY: "synthetic-mailgun-key-0001", MAILGUN_DOMAIN: "mg.example.test", MAILGUN_FROM_EMAIL: "login@mg.example.test" };
const whatsapp = {
  WHATSAPP_TOKEN: "synthetic-token", WHATSAPP_PHONE_NUMBER_ID: "1000000000000001", WHATSAPP_WABA_ID: "1000000000000002",
  WHATSAPP_APP_SECRET: "synthetic-app-secret", WHATSAPP_VERIFY_TOKEN: "synthetic-verify",
};
const FAKE_NOTE = "SECRET-NOTE-private-details";
const FAKE_TEXT = "SECRET-MESSAGE-text-body";
const FAKE_PHONE = "9876500001";
const templates = [
  { name: "hello_world", language: "en_US", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Hello" }] },
];
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);

function stubNetwork(t) {
  const mails = [], sends = [], logs = [];
  const state = { failSends: false };
  const original = globalThis.fetch;
  const log = console.log;
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    if (target.hostname === "api.mailgun.net") {
      mails.push({ text: init.body.get("text") });
      return new Response("{}", { status: 200 });
    }
    if (target.pathname.endsWith("/message_templates")) {
      return new Response(JSON.stringify({ data: templates }), { status: 200 });
    }
    if (state.failSends) return new Response(JSON.stringify({ error: { code: 131026, message: "secret provider text" } }), { status: 400 });
    sends.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${sends.length}` }] }), { status: 200 });
  };
  console.log = (...args) => { logs.push(args.map(String).join(" ")); };
  t.after(() => { globalThis.fetch = original; console.log = log; });
  return { mails, sends, logs, state };
}

async function fixture(t) {
  const network = stubNetwork(t);
  const DB = await createDatabase(t);
  await enableFeatures(DB);
  const runtime = new Miniflare({
    workers: [{ config: {
      name: "activity-tests", compatibilityDate: "2026-09-24",
      manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default { fetch() { return new Response(null, { status: 404 }); } }" } } },
      env: { RECORDINGS: { type: "r2", name: "activity-test-bucket" } },
    } }],
  });
  t.after(() => runtime.dispose());
  const RECORDINGS = await runtime.getR2Bucket("RECORDINGS");
  const env = { DB, RECORDINGS, TOKEN_HASH_SECRET: tokenSecret, LOCAL_ADMIN_SECRET: adminSecret, ENVIRONMENT: "development", MAX_RECORDING_BYTES: "1048576", ...mail, ...whatsapp };
  const app = createApp();
  const identity = createIdentityRepository(DB, tokenSecret);
  const request = (path, init = {}, overrides = {}) => app.request(new URL(path, "http://127.0.0.1"), init, { ...env, ...overrides });
  const admin = (method, path, body) => request(path, {
    method,
    headers: { Authorization: `Bearer ${adminSecret}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const device = (enrolled, method, path, body) => request(path, {
    method,
    headers: { Authorization: `Bearer ${enrolled.deviceToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const web = (path, { method = "GET", body, session, ip = "203.0.113.7", agent = "Synthetic Browser/1.0" } = {}) => request(path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(session ? { Cookie: session.cookie } : {}),
      ...(session && method !== "GET" ? { "X-Linekeep-CSRF": session.csrf } : {}),
      "CF-Connecting-IP": ip, "User-Agent": agent,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const rows = async (where = "1 = 1", ...bindings) =>
    (await DB.prepare(`SELECT * FROM activity_log WHERE ${where} ORDER BY occurred_at, id`).bind(...bindings).all()).results
      .map((row) => ({ ...row, details: JSON.parse(row.details) }));
  const resetCooldown = () => DB.prepare("UPDATE web_rate_counters SET last_at = '2000-01-01T00:00:00.000Z'").run();
  const employee = async (name, extra = {}) => (await (await admin("POST", "/v1/admin/employees", { name, ...extra })).json()).employee;
  const enroll = async (who) => identity.redeemInvitation(
    (await identity.createInvitation(who.id, "2099-01-01T00:00:00Z")).invitationCode, { model: "Synthetic phone" });
  const signIn = async (email) => {
    await resetCooldown();
    assert.equal((await web("/v1/web/auth/request", { method: "POST", body: { method: "email", email } })).status, 202);
    const code = network.mails.at(-1).text.match(/\b(\d{6})\b/)[1];
    const verified = await web("/v1/web/auth/verify", { method: "POST", body: { method: "email", email, code } });
    assert.equal(verified.status, 200);
    const body = await verified.json();
    return { cookie: verified.headers.get("set-cookie").split(";")[0], csrf: body.csrfToken, code };
  };
  return { DB, RECORDINGS, env, app, request, admin, device, web, rows, resetCooldown, employee, enroll, signIn, identity, ...network };
}

const customerOf = async (response) => (await response.json()).customer;

test("sign-in events: request, wrong code, success, sign-out and revocation, with the address but never the code", async (t) => {
  const f = await fixture(t);
  const asha = await f.employee("Asha Synthetic", { email: "asha@example.test" });
  assert.equal((await f.admin("PUT", "/v1/admin/settings/employeeWeb", { enabled: true })).status, 200);

  // Unknown address: nothing is logged.
  await f.web("/v1/web/auth/request", { method: "POST", body: { method: "email", email: "nobody@example.test" } });
  assert.deepEqual(await f.rows("category = 'signin'"), []);

  await f.resetCooldown();
  assert.equal((await f.web("/v1/web/auth/request", { method: "POST", body: { method: "email", email: "asha@example.test" }, ip: "203.0.113.50" })).status, 202);
  const code = f.mails.at(-1).text.match(/\b(\d{6})\b/)[1];
  // A second request inside the cooldown is refused and logged as a rate limit.
  assert.equal((await f.web("/v1/web/auth/request", { method: "POST", body: { method: "email", email: "asha@example.test" } })).status, 429);
  const wrong = code === "000000" ? "111111" : "000000";
  assert.equal((await f.web("/v1/web/auth/verify", { method: "POST", body: { method: "email", email: "asha@example.test", code: wrong } })).status, 401);
  const verified = await f.web("/v1/web/auth/verify", { method: "POST", body: { method: "email", email: "asha@example.test", code } });
  assert.equal(verified.status, 200);
  const session = { cookie: verified.headers.get("set-cookie").split(";")[0], csrf: (await verified.json()).csrfToken };
  assert.equal((await f.web("/v1/web/auth/logout", { method: "POST", session })).status, 200);

  const signin = await f.rows("category = 'signin'");
  assert.deepEqual(signin.map((row) => row.action), ["code_requested", "rate_limited", "sign_in_failed", "signed_in", "signed_out"]);
  for (const row of signin) {
    assert.equal(row.actor_type, "employee");
    assert.equal(row.actor_id, asha.id);
    assert.equal(row.actor_name, "Asha Synthetic");
    assert.equal(row.channel, "web");
    assert.ok(row.ip && row.user_agent, `${row.action} keeps the security fields`);
  }
  assert.equal(signin[0].ip, "203.0.113.50");
  assert.deepEqual(signin[0].details, { method: "email" });
  assert.deepEqual(signin[2].details, { method: "email", reason: "wrong_code" });
  const everything = JSON.stringify(await f.rows());
  assert.ok(!everything.includes(code) && !everything.includes(wrong), "codes are never stored");
  assert.ok(!everything.includes("asha@example.test"), "the address is never stored");

  // Admin revokes sessions: only when there was something to revoke.
  const again = await f.signIn("asha@example.test");
  assert.ok(again.cookie);
  assert.equal((await f.admin("DELETE", `/v1/admin/employees/${asha.id}/web-sessions`)).status, 200);
  assert.equal((await f.admin("DELETE", `/v1/admin/employees/${asha.id}/web-sessions`)).status, 200);
  const revoked = await f.rows("action = 'session_revoked'");
  assert.equal(revoked.length, 1);
  assert.deepEqual([revoked[0].actor_type, revoked[0].actor_id, revoked[0].actor_name, revoked[0].channel, revoked[0].target_id, revoked[0].details.count],
    ["admin", "local", "Local admin", "admin", asha.id, 1]);
  assert.equal(revoked[0].ip, null, "only the employee's own sign-in events keep an address");
});

test("admin and employee changes name the fields, never the values", async (t) => {
  const f = await fixture(t);
  const ravi = await f.employee("Ravi Synthetic", { email: "ravi@example.test", phoneNumber: "+919800000077" });
  assert.equal((await f.admin("PATCH", `/v1/admin/employees/${ravi.id}`, { name: "Ravi S", email: null, phoneNumber: "+919800000078" })).status, 200);
  assert.equal((await f.admin("PATCH", `/v1/admin/employees/${ravi.id}`, { name: "Ravi S" })).status, 200);
  const rows = await f.rows("category = 'admin'");
  assert.deepEqual(rows.map((row) => row.action), ["employee_created", "employee_updated"]);
  assert.deepEqual(rows[1].details, { fields: ["name", "phone", "email"] });
  assert.equal(rows[1].target_label, "Ravi S");
  const text = JSON.stringify(await f.rows());
  for (const secret of ["ravi@example.test", "9800000077", "9800000078"]) assert.ok(!text.includes(secret));

  // Settings: the section and the key names, never the value.
  assert.equal((await f.admin("PUT", "/v1/admin/settings/whatsapp", { token: "synthetic-super-secret-token-value", phoneNumberId: "1000000000000009" })).status, 200);
  assert.equal((await f.admin("PUT", "/v1/admin/settings/activity", { retentionDays: 30 })).status, 200);
  const saved = await f.rows("action = 'settings_saved'");
  assert.deepEqual(saved.map((row) => row.details), [
    { section: "whatsapp", keys: ["whatsapp.token", "whatsapp.phoneNumberId"] },
    { section: "activity", keys: ["activity.retentionDays"] },
  ]);
  const settings = (await (await f.admin("GET", "/v1/admin/settings")).json()).settings;
  assert.deepEqual(settings.activity, { retentionDays: 30 });
  assert.equal((await f.admin("PUT", "/v1/admin/settings/activity", { retentionDays: 99999 })).status, 400);
  assert.equal((await f.admin("PUT", "/v1/admin/settings/activity", { retentionDays: null })).status, 200);
  assert.equal((await (await f.admin("GET", "/v1/admin/settings")).json()).settings.activity.retentionDays, 90);
  const all = JSON.stringify(await f.rows());
  assert.ok(!all.includes("synthetic-super-secret-token-value") && !all.includes("1000000000000009"));
});

test("customer events from the admin, the phone app and the web app", async (t) => {
  const f = await fixture(t);
  const priya = await f.employee("Priya Synthetic", { email: "priya@example.test" });
  const dev = await f.enroll(priya);
  assert.equal((await f.admin("PUT", "/v1/admin/settings/employeeWeb", { enabled: true })).status, 200);
  const sess = await f.signIn("priya@example.test");

  const bySummary = await customerOf(await f.admin("POST", "/v1/admin/customers", { name: "Sunrise Traders", phone: FAKE_PHONE, notes: FAKE_NOTE, employeeIds: [priya.id] }));
  const created = await customerOf(await f.device(dev, "POST", "/v1/device/customers", { name: "Phone Customer", phone: "9876500002", notes: FAKE_NOTE }));
  const webCreated = await customerOf(await f.web("/v1/web/customers", { method: "POST", session: sess, body: { name: "Web Customer", phone: "9876500003" } }));
  assert.equal((await f.device(dev, "PATCH", `/v1/device/customers/${created.id}`, { name: "Phone Customer 2", notes: FAKE_NOTE })).status, 200);
  // No change at all: nothing is logged.
  assert.equal((await f.device(dev, "PATCH", `/v1/device/customers/${created.id}`, { name: "Phone Customer 2" })).status, 200);
  assert.equal((await f.admin("PATCH", `/v1/admin/customers/${bySummary.id}`, { email: "buyer@example.test", district: "Synthetic district" })).status, 200);
  const other = await f.employee("Meera Synthetic");
  assert.equal((await f.admin("PUT", `/v1/admin/customers/${bySummary.id}/employees`, { employeeIds: [other.id] })).status, 200);
  assert.equal((await f.admin("DELETE", `/v1/admin/customers/${webCreated.id}`)).status, 200);

  const rows = await f.rows("category = 'customer'");
  const brief = rows.map((row) => [row.action, row.actor_type, row.actor_name, row.channel, row.target_label, row.details]);
  assert.deepEqual(brief, [
    ["created", "admin", "Local admin", "admin", "Sunrise Traders", { source: "admin", assigned: 1 }],
    ["created", "employee", "Priya Synthetic", "app", "Phone Customer", { source: "employee_app", assigned: 1 }],
    ["created", "employee", "Priya Synthetic", "web", "Web Customer", { source: "employee_web", assigned: 1 }],
    ["updated", "employee", "Priya Synthetic", "app", "Phone Customer 2", { fields: ["name"] }],
    ["updated", "admin", "Local admin", "admin", "Sunrise Traders", { fields: ["email", "district"] }],
    ["assigned", "admin", "Local admin", "admin", "Sunrise Traders", { employees: ["Meera Synthetic"] }],
    ["unassigned", "admin", "Local admin", "admin", "Sunrise Traders", { employees: ["Priya Synthetic"] }],
    ["archived", "admin", "Local admin", "admin", "Web Customer", {}],
  ]);
  assert.equal(rows[0].target_id, bySummary.id);
  const text = JSON.stringify(await f.rows());
  for (const secret of [FAKE_NOTE, FAKE_PHONE, "buyer@example.test", "Synthetic district"]) assert.ok(!text.includes(secret), secret);
});

test("WhatsApp sends and uploads", async (t) => {
  const f = await fixture(t);
  const priya = await f.employee("Priya Synthetic");
  const dev = await f.enroll(priya);
  const customer = await customerOf(await f.admin("POST", "/v1/admin/customers", { name: "Sunrise Traders", phone: FAKE_PHONE, employeeIds: [priya.id] }));

  // The window is closed: a text is refused and not logged; a template goes out.
  assert.equal((await f.device(dev, "POST", `/v1/device/customers/${customer.id}/messages`, { clientMessageId: crypto.randomUUID(), text: FAKE_TEXT })).status, 409);
  const templateBody = () => ({ clientMessageId: crypto.randomUUID(), template: { name: "hello_world", language: "en_US", params: [] } });
  assert.equal((await f.device(dev, "POST", `/v1/device/customers/${customer.id}/messages`, templateBody())).status, 201);
  const repeated = templateBody();
  assert.equal((await f.admin("POST", `/v1/admin/customers/${customer.id}/messages`, repeated)).status, 201);
  assert.equal((await f.admin("POST", `/v1/admin/customers/${customer.id}/messages`, repeated)).status, 201);
  f.state.failSends = true;
  assert.equal((await f.device(dev, "POST", `/v1/device/customers/${customer.id}/messages`, templateBody())).status, 502);
  f.state.failSends = false;

  // An inbound customer message opens the window; then employee text and an attachment go out.
  await f.DB.prepare(
    `INSERT INTO whatsapp_messages (id, customer_id, direction, message_type, body, status, sent_at, source, created_at)
     VALUES ('wam_open', ?, 'in', 'text', 'hi', 'delivered', ?, 'import', ?)`,
  ).bind(customer.id, new Date().toISOString(), new Date().toISOString()).run();
  assert.equal((await f.device(dev, "POST", `/v1/device/customers/${customer.id}/messages`, { clientMessageId: crypto.randomUUID(), text: FAKE_TEXT })).status, 201);
  const upload = await f.request("/v1/device/whatsapp/attachments?fileName=secret-name.jpg", {
    method: "POST", headers: { Authorization: `Bearer ${dev.deviceToken}`, "Content-Type": "image/jpeg" }, body: jpeg(),
  });
  assert.equal(upload.status, 201);

  const rows = await f.rows("category = 'whatsapp'");
  assert.deepEqual(rows.map((row) => [row.action, row.actor_name, row.channel, row.details]), [
    ["message_sent", "Priya Synthetic", "app", { type: "template", templateName: "hello_world" }],
    ["message_sent", "Local admin", "admin", { type: "template", templateName: "hello_world" }],
    ["message_failed", "Priya Synthetic", "app", { type: "template", templateName: "hello_world" }],
    ["message_sent", "Priya Synthetic", "app", { type: "text" }],
    ["attachment_uploaded", "Priya Synthetic", "app", { kind: "image", bytes: 12 }],
  ]);
  assert.equal(rows[0].target_label, "Sunrise Traders");
  const text = JSON.stringify(await f.rows());
  for (const secret of [FAKE_TEXT, FAKE_PHONE, "secret-name", "secret provider text"]) assert.ok(!text.includes(secret), secret);
});

test("inbound messages and auto replies from the webhook", async (t) => {
  const f = await fixture(t);
  const payload = (id, from, body, type = "text") => ({
    entry: [{ changes: [{ field: "messages", value: {
      metadata: { phone_number_id: whatsapp.WHATSAPP_PHONE_NUMBER_ID },
      contacts: [{ wa_id: from, profile: { name: "Inbound Synthetic" } }],
      messages: [{ id, from, type, timestamp: String(Math.floor(Date.now() / 1000)), text: { body } }],
    } }] }],
  });
  const sign = async (raw) => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(whatsapp.WHATSAPP_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
    return `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  };
  const deliver = async (body) => {
    const raw = JSON.stringify(body);
    return f.request("/v1/webhooks/whatsapp", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": await sign(raw) }, body: raw });
  };
  assert.equal((await f.admin("POST", "/v1/admin/whatsapp/auto-replies", {
    name: "Hours", matchType: "contains", keywords: ["hours"], reply: { type: "text", text: "We open at nine" }, cooldownMinutes: 60,
  })).status, 201);
  assert.equal((await deliver(payload("wamid.IN1", "919876500777", FAKE_TEXT + " hours"))).status, 200);
  // A redelivery adds nothing.
  assert.equal((await deliver(payload("wamid.IN1", "919876500777", FAKE_TEXT + " hours"))).status, 200);
  const rows = await f.rows("category IN ('whatsapp', 'customer') OR action = 'auto_replies_changed'");
  assert.deepEqual(rows.map((row) => [row.category, row.action, row.actor_type, row.channel, row.details]), [
    ["admin", "auto_replies_changed", "admin", "admin", { change: "created" }],
    ["customer", "created", "customer", "system", { source: "whatsapp_inbound" }],
    ["whatsapp", "message_received", "customer", "system", { type: "text" }],
    ["whatsapp", "auto_reply_sent", "system", "system", { type: "text" }],
  ]);
  const received = rows.find((row) => row.action === "message_received");
  assert.equal(received.actor_name, "Inbound Synthetic");
  assert.equal(received.target_label, "Inbound Synthetic");
  const text = JSON.stringify(await f.rows());
  for (const secret of [FAKE_TEXT, "We open at nine", "9876500777"]) assert.ok(!text.includes(secret), secret);
});

test("a customer whose name is a phone number is stored masked", async (t) => {
  const f = await fixture(t);
  const customer = await customerOf(await f.admin("POST", "/v1/admin/customers", { name: "+91 98765 00123", phone: "9876500123" }));
  const [row] = await f.rows("target_id = ?", customer.id);
  assert.equal(row.target_label, "••••0123");
  assert.ok(!JSON.stringify(await f.rows()).includes("98765"));
});

test("device events: enrolment, version change, merged syncs and recording uploads", async (t) => {
  const f = await fixture(t);
  const priya = await f.employee("Priya Synthetic");
  const invitation = (await (await f.admin("POST", `/v1/admin/employees/${priya.id}/invitations`)).json());
  const registered = await f.request("/v1/device/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invitationCode: invitation.invitationCode, device: { model: "Synthetic M1", androidVersion: "14", appVersion: "1.0.0", phoneNumbers: ["+919800000099"] } }),
  });
  assert.equal(registered.status, 201);
  const dev = await registered.json();
  const heartbeat = (appVersion) => f.device(dev, "POST", "/v1/device/heartbeat", { appVersion, pendingUploads: 0 });
  assert.equal((await heartbeat("1.0.0")).status, 200);
  assert.equal((await heartbeat("1.0.0")).status, 200);
  assert.equal((await heartbeat("1.1.0")).status, 200);

  const entry = (n) => ({ startedAt: "2026-10-12T04:00:00.000Z", durationSeconds: 5, callType: "outgoing", remoteNumber: `+9198765001${String(n).padStart(2, "0")}`, fingerprint: n.toString(16).padStart(64, "0") });
  const batch = (entries) => f.device(dev, "POST", "/v1/device/call-logs/batch", { deviceId: dev.deviceId, entries });
  assert.equal((await batch([entry(1), entry(2)])).status, 200);
  assert.equal((await batch([entry(3)])).status, 200);
  let syncs = await f.rows("action = 'call_sync'");
  assert.equal(syncs.length, 1, "bursts merge into one row");
  assert.equal(syncs[0].details.calls, 3);
  assert.equal(syncs[0].details.batches, 2);
  assert.equal(syncs[0].target_id, dev.deviceId);
  assert.equal(syncs[0].actor_name, "Priya Synthetic");
  // Past the window the next batch starts a new row.
  await f.DB.prepare("UPDATE activity_log SET occurred_at = '2000-01-01T00:00:00.000Z', details = json_set(details, '$.since', '2000-01-01T00:00:00.000Z') WHERE action = 'call_sync'").run();
  assert.equal((await batch([entry(4)])).status, 200);
  syncs = await f.rows("action = 'call_sync'");
  assert.equal(syncs.length, 2);

  const rows = await f.rows("category = 'device' AND action <> 'call_sync'");
  assert.deepEqual(rows.map((row) => [row.action, row.actor_type, row.channel, row.target_label, row.details]), [
    ["invitation_created", "admin", "admin", "Priya Synthetic", {}],
    ["enrolled", "employee", "app", "Synthetic M1", { model: "Synthetic M1", androidVersion: "14", appVersion: "1.0.0", recovered: false }],
    ["app_version_changed", "employee", "app", "Synthetic M1", { from: "1.0.0", to: "1.1.0" }],
  ]);
  // Revoking, recovering and reassigning.
  assert.equal((await f.admin("POST", `/v1/admin/devices/${dev.deviceId}/recovery-invitations`)).status, 201);
  const second = await f.employee("Meera Synthetic");
  assert.equal((await f.admin("PATCH", `/v1/admin/devices/${dev.deviceId}`, { employeeId: second.id })).status, 200);
  assert.equal((await f.admin("POST", `/v1/admin/devices/${dev.deviceId}/revoke`)).status, 200);
  const later = await f.rows("action IN ('recovery_invited', 'reassigned', 'revoked')");
  assert.deepEqual(later.map((row) => [row.action, row.details]), [["recovery_invited", {}], ["reassigned", { toEmployee: "Meera Synthetic" }], ["revoked", {}]]);
  assert.ok(!JSON.stringify(await f.rows()).includes("9800000099"));
});

test("recording uploads merge, and playing or deleting a recording is logged with the customer", async (t) => {
  const f = await fixture(t);
  const priya = await f.employee("Priya Synthetic");
  const dev = await f.enroll(priya);
  const customer = await customerOf(await f.admin("POST", "/v1/admin/customers", { name: "Sunrise Traders", phone: FAKE_PHONE, employeeIds: [priya.id] }));
  const bytes = new TextEncoder().encode("0123456789");
  const callRepo = createCallRepository(f.DB);
  const upload = async (n) => {
    // The audio goes straight into the bucket (the streaming PUT needs the Workers runtime); the route under test is /complete.
    const pending = await callRepo.createPending({
      deviceId: dev.device.id, fingerprint: n.toString(16).padStart(64, "0"), displayName: "call.wav", contentType: "audio/wav",
      expectedBytes: bytes.length, matchStatus: "unmatched", remoteNumber: `+91${FAKE_PHONE}`, direction: "outgoing",
    });
    const object = await f.RECORDINGS.put(pending.objectKey, bytes, { httpMetadata: { contentType: "audio/wav" } });
    const done = await f.device(dev, "POST", `/v1/device/uploads/${pending.id}/complete`, { actualBytes: bytes.length, etag: object.etag });
    assert.equal(done.status, 200, await done.clone().text());
    return pending.id;
  };
  const first = await upload(1);
  await upload(2);
  const uploads = await f.rows("action = 'recording_uploaded'");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].details.count, 2);
  assert.equal(uploads[0].details.bytes, 20);

  const played = await f.admin("POST", `/v1/admin/calls/${first}/playback`);
  assert.equal(played.status, 200, await played.clone().text());
  assert.equal((await f.admin("DELETE", `/v1/admin/calls/${first}`)).status, 200);
  assert.equal((await f.admin("DELETE", `/v1/admin/calls/${first}`)).status, 200);
  const calls = await f.rows("category = 'call'");
  assert.deepEqual(calls.map((row) => [row.action, row.actor_type, row.target_type, row.target_id, row.target_label]), [
    ["recording_played", "admin", "customer", customer.id, "Sunrise Traders"],
    ["recording_deleted", "admin", "customer", customer.id, "Sunrise Traders"],
  ]);
  assert.deepEqual(calls[0].details, { callId: first });

  // A call-log deletion, once.
  await f.DB.prepare(
    `INSERT INTO call_logs (id, device_id, employee_id, fingerprint, started_at, duration_seconds, call_type, remote_number, created_at)
     VALUES ('log_1', ?, ?, ?, '2026-10-12T04:00:00.000Z', 60, 'outgoing', '+919000000001', '2026-10-12T04:00:00.000Z')`,
  ).bind(dev.device.id, priya.id, "e".repeat(64)).run();
  assert.equal((await f.admin("DELETE", "/v1/admin/call-logs/log_1")).status, 200);
  assert.equal((await f.admin("DELETE", "/v1/admin/call-logs/log_1")).status, 200);
  assert.equal((await f.rows("action = 'call_log_deleted'")).length, 1);
  assert.ok(!JSON.stringify(await f.rows()).includes(FAKE_PHONE));
});

test("an employee playing a recording in the web app is logged on the web channel", async (t) => {
  const f = await fixture(t);
  const priya = await f.employee("Priya Synthetic", { email: "priya@example.test" });
  const dev = await f.enroll(priya);
  await f.admin("PUT", "/v1/admin/settings/employeeWeb", { enabled: true });
  const sess = await f.signIn("priya@example.test");
  await f.DB.prepare(
    `INSERT INTO call_logs (id, device_id, employee_id, fingerprint, started_at, duration_seconds, call_type, remote_number, created_at)
     VALUES ('log_w', ?, ?, ?, '2026-10-12T04:00:00.000Z', 60, 'outgoing', '+919000000001', '2026-10-12T04:00:00.000Z')`,
  ).bind(dev.device.id, priya.id, "d".repeat(64)).run();
  await f.RECORDINGS.put("recordings/w.m4a", new TextEncoder().encode("audio"), { httpMetadata: { contentType: "audio/mp4" } });
  await f.DB.prepare(
    `INSERT INTO calls (id, employee_id, device_id, fingerprint, display_name, match_status, object_key, content_type, expected_bytes, upload_status, created_at, call_log_id)
     VALUES ('rec_w', ?, ?, 'fp-w', 'call.m4a', 'call_log', 'recordings/w.m4a', 'audio/mp4', 5, 'complete', '2026-10-12T04:00:00.000Z', 'log_w')`,
  ).bind(priya.id, dev.device.id).run();
  await f.DB.prepare("UPDATE calls SET call_log_id = 'log_w' WHERE id = 'rec_w'").run();
  const response = await f.web("/v1/web/call-history/log_w/recording", { session: sess });
  assert.equal(response.status, 200, await response.clone().text());
  const [row] = await f.rows("action = 'recording_played'");
  assert.deepEqual([row.actor_type, row.channel, row.target_type, row.target_id], ["employee", "web", "call", "log_w"]);
});

test("recording never breaks or fails the action, even when the log is broken", async (t) => {
  const f = await fixture(t);
  await f.DB.prepare("DROP TABLE activity_log").run();
  const created = await f.admin("POST", "/v1/admin/employees", { name: "Resilient Synthetic" });
  assert.equal(created.status, 201);
  assert.ok(f.logs.some((line) => line.includes('"job":"activity-log"') && line.includes('"dropped":1')));
  assert.ok(f.logs.every((line) => !line.includes("Resilient")), "the log line carries no event data");

  // A database that throws synchronously while preparing, and one that rejects on run.
  const throwing = { prepare() { throw new Error("boom"); }, batch: async () => { throw new Error("boom"); } };
  await recordActivity({ env: { DB: throwing } }, { actor: { type: "system" }, channel: "system", category: "admin", action: "settings_saved" });
  await recordActivityBatch({ env: { DB: throwing } }, [{ actor: { type: "system" }, channel: "system", category: "admin", action: "settings_saved" }]);
  await recordMergedActivity({ env: { DB: throwing } }, { actor: { type: "system" }, channel: "system", category: "device", action: "call_sync", target: { type: "device", id: "dev_x" } }, { calls: 1 });
  await touchEmployeeActivity({ env: { DB: throwing } }, "emp_x", "app");
});

test("the recorder keeps only catalogued actions and allow-listed detail keys, and defers when it can", async (t) => {
  const f = await fixture(t);
  const source = { env: { DB: f.DB } };
  const base = { actor: { type: "system" }, channel: "system" };
  await recordActivity(source, { ...base, category: "admin", action: "not_a_real_action" });
  await recordActivity(source, { ...base, category: "admin", action: "settings_saved", details: {
    section: "email", keys: ["email.apiKey"], value: "leaked-value", note: FAKE_NOTE, nested: { a: 1 }, phone: "+919800000001" } });
  const rows = await f.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].details, { section: "email", keys: ["email.apiKey"] });

  const deferred = [];
  await recordActivity({ env: { DB: f.DB }, waitUntil: (work) => deferred.push(work) }, { ...base, category: "admin", action: "settings_saved" });
  assert.equal(deferred.length, 1, "the write is handed to waitUntil");
  await Promise.all(deferred);
  assert.equal((await f.rows()).length, 2);
});

test("last active is updated at most every five minutes and shown on the employee list", async (t) => {
  const f = await fixture(t);
  const priya = await f.employee("Priya Synthetic");
  assert.equal((await (await f.admin("GET", "/v1/admin/employees")).json()).items[0].lastActiveAt, null);
  const dev = await f.enroll(priya);
  assert.equal((await f.device(dev, "GET", "/v1/device/profile")).status, 200);
  const first = (await (await f.admin("GET", "/v1/admin/employees")).json()).items[0].lastActiveAt;
  assert.ok(first && Date.now() - Date.parse(first) < 60_000);
  const write = (now) => touchEmployeeActivity({ env: { DB: f.DB } }, priya.id, "web", now);
  const stamp = async () => (await f.DB.prepare("SELECT last_active_at, last_channel FROM employee_activity_summary WHERE employee_id = ?").bind(priya.id).first());
  const base = Date.now();
  await write(base + 60_000);
  assert.equal((await stamp()).last_active_at, first, "inside five minutes nothing is written");
  await write(base + 6 * 60_000);
  const later = await stamp();
  assert.equal(later.last_active_at, new Date(base + 6 * 60_000).toISOString());
  assert.equal(later.last_channel, "web");
});

async function seedFeed(f) {
  const insert = f.DB.prepare(
    `INSERT INTO activity_log (id, occurred_at, actor_type, actor_id, actor_name, category, action, target_type, target_id, target_label, channel, details, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const row = (id, at, actorType, actorId, actorName, category, action, targetType, targetId, label, channel, details = {}, ip = null, agent = null) =>
    insert.bind(id, at, actorType, actorId, actorName, category, action, targetType, targetId, label, channel, JSON.stringify(details), ip, agent);
  await f.DB.batch([
    row("act_1", "2026-10-11T18:29:59.999Z", "employee", "emp_a", "Asha", "customer", "created", "customer", "cus_1", "Sunrise Traders", "app", { source: "employee_app" }),
    row("act_2", "2026-10-11T18:30:00.000Z", "employee", "emp_a", "Asha", "whatsapp", "message_sent", "customer", "cus_1", "Sunrise Traders", "app", { type: "template" }),
    row("act_3", "2026-10-12T05:00:00.000Z", "employee", "emp_b", "=HYPERLINK(\"http://x\")", "signin", "signed_in", null, null, null, "web", { method: "email" }, "203.0.113.9", "Browser/1"),
    row("act_4", "2026-10-12T05:00:00.000Z", "customer", "cus_1", "Sunrise Traders", "whatsapp", "message_received", "customer", "cus_1", "Sunrise Traders", "system", { type: "text" }),
    row("act_5", "2026-10-12T06:00:00.000Z", "admin", "local", "Local admin", "admin", "employee_updated", "employee", "emp_a", "Asha 100%_off", "admin", { fields: ["name"] }),
    row("act_6", "2026-10-12T07:00:00.000Z", "system", null, null, "whatsapp", "auto_reply_sent", "customer", "cus_1", "Sunrise Traders", "system", { type: "text" }),
    row("act_7", "2026-10-12T08:00:00.000Z", "employee", "emp_a", "Asha", "call", "recording_played", "customer", "cus_1", "+cmd|' /c calc'!A0", "web", { callId: "x" }),
  ]);
}

test("the feed filters, paginates and hides customer messages by default", async (t) => {
  const f = await fixture(t);
  await seedFeed(f);
  const get = async (query) => {
    const response = await f.admin("GET", `/v1/admin/activity${query}`);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const ids = async (query) => (await get(query)).items.map((item) => item.id);
  assert.deepEqual(await ids(""), ["act_7", "act_6", "act_5", "act_3", "act_2", "act_1"], "customer messages hidden, newest first");
  assert.deepEqual(await ids("?includeCustomerMessages=true"), ["act_7", "act_6", "act_5", "act_4", "act_3", "act_2", "act_1"]);
  assert.deepEqual(await ids("?employeeId=emp_a"), ["act_7", "act_5", "act_2", "act_1"], "own actions and what admins did to the employee");
  assert.deepEqual(await ids("?employeeId=admin"), ["act_5"]);
  assert.deepEqual(await ids("?employeeId=system"), ["act_6"]);
  assert.deepEqual(await ids("?category=whatsapp"), ["act_6", "act_2"]);
  assert.deepEqual(await ids("?action=signed_in"), ["act_3"]);
  assert.deepEqual(await ids("?channel=web"), ["act_7", "act_3"]);
  assert.deepEqual(await ids("?customerId=cus_1&includeCustomerMessages=true"), ["act_7", "act_6", "act_4", "act_2", "act_1"]);
  // IST day boundaries: 2026-10-12 IST starts at 2026-10-11T18:30:00Z.
  assert.deepEqual(await ids("?from=2026-10-12&to=2026-10-12"), ["act_7", "act_6", "act_5", "act_3", "act_2"]);
  assert.deepEqual(await ids("?from=2026-10-11&to=2026-10-11"), ["act_1"]);
  assert.deepEqual(await ids("?from=2026-10-13"), []);
  // Search is a literal match on actor, target label and action words.
  assert.deepEqual(await ids("?q=100%25"), ["act_5"]);
  assert.deepEqual(await ids("?q=_off"), ["act_5"]);
  assert.deepEqual(await ids("?q=%25"), ["act_5"]);
  assert.deepEqual(await ids("?q=message%20sent"), ["act_2"]);
  assert.deepEqual(await ids("?q=hyperlink"), ["act_3"]);

  // Cursor pagination over equal timestamps.
  const all = [];
  let cursor = "";
  for (let pages = 0; pages < 10; pages += 1) {
    const page = await get(`?includeCustomerMessages=true&limit=2${cursor}`);
    all.push(...page.items.map((item) => item.id));
    if (!page.nextCursor) break;
    cursor = `&cursor=${page.nextCursor}`;
  }
  assert.deepEqual(all, ["act_7", "act_6", "act_5", "act_4", "act_3", "act_2", "act_1"]);
  assert.equal(new Set(all).size, 7);

  // Fields: ip and browser only on sign-in rows; details are objects.
  const signed = (await get("?action=signed_in")).items[0];
  assert.deepEqual([signed.ip, signed.userAgent, signed.details], ["203.0.113.9", "Browser/1", { method: "email" }]);
  assert.ok(!("ip" in (await get("?action=employee_updated")).items[0]));

  for (const bad of ["?limit=201", "?limit=0", "?category=nope", "?from=2026-13-40", "?cursor=bogus!", "?extra=1", "?includeCustomerMessages=yes"]) {
    assert.equal((await f.admin("GET", `/v1/admin/activity${bad}`)).status, 400, bad);
  }
});

test("the CSV export is spreadsheet-safe, filtered, and keeps the address for sign-in rows only", async (t) => {
  const f = await fixture(t);
  await seedFeed(f);
  const response = await f.admin("GET", "/v1/admin/activity/export?includeCustomerMessages=true");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/csv/);
  assert.match(response.headers.get("content-disposition"), /^attachment; filename="linekeep-activity-/);
  const text = await response.text();
  const lines = text.trimEnd().split("\r\n");
  assert.equal(lines.length, 8);
  assert.match(lines[0], /^time_utc,time_ist,actor_type,actor,category,action,target_type,target,channel,details,ip,browser$/);
  assert.ok(text.includes(`"'=HYPERLINK(""http://x"")"`), "formulas are neutralised");
  assert.ok(text.includes(`'+cmd|' /c calc'!A0`) || text.includes(`"'+cmd|' /c calc'!A0"`));
  assert.ok(!/(^|,)[=+\-@]/m.test(lines.slice(1).join("\n").replace(/"[^"]*"/g, "")), "no cell starts with a formula character");
  assert.equal(text.match(/203\.0\.113\.9/g)?.length, 1);
  assert.equal(text.match(/Browser\/1/g)?.length, 1);
  assert.ok(lines.some((line) => line.startsWith("2026-10-12T05:00:00.000Z,2026-10-12 10:30:00,")), "IST time column");
  const filtered = await (await f.admin("GET", "/v1/admin/activity/export?category=admin")).text();
  assert.equal(filtered.trimEnd().split("\r\n").length, 2);
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("\tx"), "'\tx");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell(null), "");
});

test("the export stops at 5000 rows", async (t) => {
  const f = await fixture(t);
  await f.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
     INSERT INTO activity_log (id, occurred_at, actor_type, category, action, channel)
     SELECT 'act_bulk_' || i, strftime('%Y-%m-%dT%H:%M:%fZ', 1790000000 + i, 'unixepoch'), 'system', 'admin', 'settings_saved', 'system' FROM n`,
  ).run();
  const response = await f.admin("GET", "/v1/admin/activity/export");
  assert.equal(response.headers.get("x-activity-truncated"), "true");
  assert.equal((await response.text()).trimEnd().split("\r\n").length, 5001);
});

test("bulk import logs one row per customer and a summary of the intro messages", async (t) => {
  const f = await fixture(t);
  const priya = await f.employee("Priya Synthetic");
  const response = await f.admin("POST", "/v1/admin/customers/bulk", {
    rows: [
      { name: "Bulk One", phone: "9876500011", notes: FAKE_NOTE, employeeId: priya.id },
      { name: "Bulk Two", phone: "9876500012" },
      { name: "Bad Row", phone: "12" },
    ],
    intro: { template: { name: "hello_world", language: "en_US", params: [] } },
  });
  assert.equal(response.status, 200, await response.clone().text());
  const rows = await f.rows("category IN ('customer', 'whatsapp')");
  assert.deepEqual(rows.map((row) => [row.action, row.actor_type, row.target_label, row.details]), [
    ["created", "admin", "Bulk One", { source: "bulk_import", assigned: 1 }],
    ["created", "admin", "Bulk Two", { source: "bulk_import", assigned: 0 }],
    ["bulk_intro_sent", "admin", null, { sent: 2, failed: 0, skipped: 0, templateName: "hello_world" }],
  ]);
  assert.ok(!JSON.stringify(await f.rows()).includes(FAKE_NOTE));
});

test("only administrators can read the log", async (t) => {
  const f = await fixture(t);
  const priya = await f.employee("Priya Synthetic");
  const dev = await f.enroll(priya);
  for (const path of ["/v1/admin/activity", "/v1/admin/activity/export"]) {
    assert.equal((await f.request(path)).status, 401);
    assert.equal((await f.request(path, { headers: { Authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await f.device(dev, "GET", path)).status, 401);
    assert.equal((await f.admin("GET", path)).status, 200);
  }
  // Employees have no route to it through the phone or web paths.
  assert.equal((await f.device(dev, "GET", "/v1/device/activity")).status, 404);
  assert.equal((await f.web("/v1/web/activity")).status, 404);
});

test("retention removes rows past the configured age and keeps everything when set to 0", async (t) => {
  const f = await fixture(t);
  const now = new Date("2026-11-12T00:00:00.000Z");
  const day = 86_400_000;
  const insert = (id, ageDays) => f.DB.prepare(
    `INSERT INTO activity_log (id, occurred_at, actor_type, category, action, channel) VALUES (?, ?, 'system', 'admin', 'settings_saved', 'system')`,
  ).bind(id, new Date(now.getTime() - ageDays * day).toISOString());
  await f.DB.batch([insert("act_new", 1), insert("act_89", 89), insert("act_91", 91), insert("act_old", 400)]);
  assert.equal(await purgeExpiredActivity(f.env, now), 2);
  assert.deepEqual((await f.rows()).map((row) => row.id).sort(), ["act_89", "act_new"]);
  assert.equal((await f.admin("PUT", "/v1/admin/settings/activity", { retentionDays: 30 })).status, 200);
  await f.DB.batch([insert("act_50", 50)]);
  assert.equal(await purgeExpiredActivity(f.env, now), 2);
  assert.equal((await f.admin("PUT", "/v1/admin/settings/activity", { retentionDays: 0 })).status, 200);
  await f.DB.batch([insert("act_ancient", 4000)]);
  assert.equal(await purgeExpiredActivity(f.env, now), 0);
  assert.ok((await f.rows("id = 'act_ancient'")).length === 1);
});

test("the backfill derives bounded history from earlier tables and is idempotent", async (t) => {
  const DB = await createDatabase(t, "0021_web_login_identifier.sql");
  const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
  await DB.batch([
    DB.prepare("INSERT INTO employees (id, name, created_at) VALUES ('emp_1', 'Asha Synthetic', ?)").bind(old),
    DB.prepare("INSERT INTO devices (id, employee_id, token_hash, model, created_at, last_seen_at, revoked_at) VALUES ('dev_1', 'emp_1', 'h1', 'Synthetic M1', ?, ?, ?)").bind(recent, recent, recent),
    DB.prepare("INSERT INTO devices (id, employee_id, token_hash, model, created_at) VALUES ('dev_old', 'emp_1', 'h2', 'Old phone', ?)").bind(old),
    DB.prepare("INSERT INTO customers (id, name, phone, phone_key, created_at, updated_at, created_by_employee_id) VALUES ('cus_1', 'Sunrise Traders', '+919876500001', '9876500001', ?, ?, 'emp_1')").bind(recent, recent),
    DB.prepare("INSERT INTO customers (id, name, phone, phone_key, created_at, updated_at, created_by_employee_id) VALUES ('cus_old', 'Old Customer', '+919876500002', '9876500002', ?, ?, 'emp_1')").bind(old, old),
    DB.prepare("INSERT INTO customers (id, name, phone, phone_key, created_at, updated_at) VALUES ('cus_num', '+91 98765 00003', '+919876500003', '9876500003', ?, ?)").bind(recent, recent),
    DB.prepare(`INSERT INTO whatsapp_messages (id, customer_id, direction, message_type, body, status, sent_at, sent_by_employee_id, source, created_at)
      VALUES ('wam_1', 'cus_num', 'out', 'template', ?, 'sent', ?, 'emp_1', 'app', ?)`).bind(FAKE_TEXT, recent, recent),
    DB.prepare(`INSERT INTO whatsapp_messages (id, customer_id, direction, message_type, body, status, sent_at, source, created_at)
      VALUES ('wam_2', 'cus_num', 'out', 'text', 'admin sent', 'sent', ?, 'app', ?)`).bind(recent, recent),
    DB.prepare("INSERT INTO web_sessions (id, employee_id, token_hash, created_at, last_seen_at, expires_at, idle_expires_at) VALUES ('wss_1', 'emp_1', 't1', ?, ?, ?, ?)").bind(recent, recent, recent, recent),
  ]);
  const migration = unstable_splitSqlQuery(await readFile(new URL("../../../migrations/0022_activity_log.sql", import.meta.url), "utf8"));
  await DB.batch(migration.map((statement) => DB.prepare(statement)));
  const summary = async () => ({
    log: (await DB.prepare("SELECT id, occurred_at, actor_name, category, action, target_label, details FROM activity_log ORDER BY id").all()).results,
    active: (await DB.prepare("SELECT * FROM employee_activity_summary").all()).results,
  });
  const first = await summary();
  assert.deepEqual(first.log.map((row) => row.id), [
    "act_bf_cus_cus_1", "act_bf_dev_dev_1", "act_bf_rev_dev_1", "act_bf_wam_wam_1", "act_bf_wss_wss_1",
  ]);
  const byId = Object.fromEntries(first.log.map((row) => [row.id, row]));
  assert.equal(byId.act_bf_wam_wam_1.target_label, "••••0003", "a phone-number name is masked");
  assert.equal(byId.act_bf_wam_wam_1.actor_name, "Asha Synthetic");
  for (const row of first.log) assert.equal(JSON.parse(row.details).backfilled, true);
  assert.ok(!JSON.stringify(first.log).includes(FAKE_TEXT));
  assert.deepEqual(first.active.map((row) => [row.employee_id, row.last_active_at]), [["emp_1", recent]]);
  // Running the data statements again changes nothing.
  await DB.batch(migration.filter((statement) => /^\s*INSERT/i.test(statement)).map((statement) => DB.prepare(statement)));
  assert.deepEqual(await summary(), first);
});
