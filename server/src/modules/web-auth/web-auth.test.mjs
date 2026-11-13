import assert from "node:assert/strict";
import test from "node:test";

import { Miniflare } from "miniflare";

import { createDatabase, enableFeatures, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { createIdentityRepository } = await loadModule("./identity.ts");
const adminSecret = "synthetic-web-admin-secret-not-for-deployment";
const tokenSecret = "synthetic-web-token-secret-not-for-deployment";
const mailEnv = { MAILGUN_API_KEY: "synthetic-mailgun-key-0001", MAILGUN_DOMAIN: "mg.example.test", MAILGUN_FROM_EMAIL: "login@mg.example.test" };
const whatsappEnv = {
  WHATSAPP_TOKEN: "synthetic-token", WHATSAPP_PHONE_NUMBER_ID: "1000000000000001", WHATSAPP_WABA_ID: "1000000000000002",
  WHATSAPP_APP_SECRET: "synthetic-app-secret", WHATSAPP_VERIFY_TOKEN: "synthetic-verify",
};
const origin = "http://127.0.0.1";
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);

const templates = [
  { name: "login_code", language: "en_US", status: "APPROVED", category: "UTILITY", components: [
    { type: "BODY", text: "Hi {{2}}, your Linekeep code is {{1}}.", example: { body_text: [["123456", "Sam"]] } }] },
  { name: "auth_code", language: "en_US", status: "APPROVED", category: "AUTHENTICATION", components: [
    { type: "BODY", text: "{{1}} is your verification code.", add_security_recommendation: true },
    { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy code" }] }] },
  { name: "with_image", language: "en_US", status: "APPROVED", category: "MARKETING", components: [
    { type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Look at {{1}}" }] },
  { name: "greeting_code", language: "en_US", status: "APPROVED", category: "MARKETING", components: [
    { type: "HEADER", format: "TEXT", text: "Greetings from Elder marketing" },
    { type: "BODY", text: "Hello, {{1}} Thank you", example: { body_text: [["123456"]] } },
    { type: "FOOTER", text: "Please send STOP to unsubscribe." }] },
  { name: "no_variable", language: "en_US", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Hello" }] },
];

/** Fake Mailgun and Graph APIs plus a console spy; every call is recorded. */
function stubNetwork(t) {
  const mails = [], sends = [], logs = [];
  const state = { failSends: false };
  const original = globalThis.fetch;
  const log = console.log;
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    if (target.hostname === "api.mailgun.net") {
      const form = init.body;
      mails.push({ to: form.getAll("to"), subject: form.get("subject"), text: form.get("text"), html: form.get("html"), url: String(url) });
      return new Response("{}", { status: 200 });
    }
    if (target.pathname.endsWith("/message_templates")) {
      const wanted = target.searchParams.get("name");
      return new Response(JSON.stringify({ data: templates.filter((item) => !wanted || item.name === wanted) }), { status: 200 });
    }
    if (target.pathname.endsWith("/media")) return new Response(JSON.stringify({ id: "7000001" }), { status: 200 });
    if (state.failSends) return new Response(JSON.stringify({ error: { code: 131026, message: "Message undeliverable: secret provider text" } }), { status: 400 });
    sends.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${sends.length}` }] }), { status: 200 });
  };
  console.log = (...args) => { logs.push(args.map(String).join(" ")); };
  t.after(() => { globalThis.fetch = original; console.log = log; });
  return { mails, sends, logs, state };
}

async function fixture(t, { env: extraEnv = { ...mailEnv, ...whatsappEnv }, enable = true } = {}) {
  const network = stubNetwork(t);
  const DB = await createDatabase(t);
  await enableFeatures(DB);
  const runtime = new Miniflare({
    workers: [{ config: {
      name: "web-tests", compatibilityDate: "2026-09-24",
      manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default { fetch() { return new Response(null, { status: 404 }); } }" } } },
      env: { RECORDINGS: { type: "r2", name: "web-test-bucket" } },
    } }],
  });
  t.after(() => runtime.dispose());
  const RECORDINGS = await runtime.getR2Bucket("RECORDINGS");
  const env = { DB, RECORDINGS, TOKEN_HASH_SECRET: tokenSecret, LOCAL_ADMIN_SECRET: adminSecret, ENVIRONMENT: "development", ...extraEnv };
  const app = createApp();
  const identity = createIdentityRepository(DB, tokenSecret);
  const request = (path, init = {}) => app.request(new URL(path, origin), init, env);
  const admin = (method, path, body) => request(path, {
    method,
    headers: { Authorization: `Bearer ${adminSecret}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let ipCounter = 10;
  const web = (path, { method = "GET", body, raw, session, csrf, headers = {}, ip } = {}) => request(path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(session ? { Cookie: session.cookie } : {}),
      ...(session && method !== "GET" && method !== "HEAD" && csrf !== null ? { "X-Linekeep-CSRF": csrf ?? session.csrf } : {}),
      "CF-Connecting-IP": ip ?? "203.0.113.7",
      ...headers,
    },
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const resetCooldown = () => DB.prepare("UPDATE web_rate_counters SET last_at = '2000-01-01T00:00:00.000Z'").run();
  const lastCode = () => network.mails.at(-1).text.match(/\b(\d{6})\b/)[1];
  const createEmployee = async (name, extra = {}) => (await (await admin("POST", "/v1/admin/employees", { name, ...extra })).json()).employee;
  const saveWeb = (body) => admin("PUT", "/v1/admin/settings/employeeWeb", body);
  /** Requests an emailed code (fresh cooldown and address) and signs in with it. */
  const signIn = async (email) => {
    await resetCooldown();
    const asked = await web("/v1/web/auth/request", { method: "POST", body: { email, method: "email" }, ip: `203.0.113.${ipCounter++}` });
    assert.equal(asked.status, 202);
    const code = lastCode();
    const verified = await web("/v1/web/auth/verify", { method: "POST", body: { method: "email", email, code } });
    assert.equal(verified.status, 200);
    const cookie = verified.headers.get("set-cookie").split(";")[0];
    const body = await verified.json();
    return { cookie, csrf: body.csrfToken, body, code };
  };
  if (enable) assert.equal((await saveWeb({ enabled: true })).status, 200);
  return { DB, RECORDINGS, env, request, admin, web, identity, resetCooldown, lastCode, createEmployee, saveWeb, signIn, ...network };
}

/** Two employees, each with a device, a customer, calls, a recording, chat messages and media. */
async function world(f) {
  const alice = await f.createEmployee("Alice Synthetic", { email: "Alice@Example.Test", phoneNumber: "+919800000001" });
  const bob = await f.createEmployee("Bob Synthetic", { email: "bob@example.test", phoneNumber: "+919800000002" });
  const devices = {};
  for (const employee of [alice, bob]) {
    const invitation = await f.identity.createInvitation(employee.id, "2099-01-01T00:00:00Z");
    devices[employee.id] = (await f.identity.redeemInvitation(invitation.invitationCode, { model: "Synthetic" })).device.id;
  }
  const customer = async (name, phone, owner) => (await (await f.admin("POST", "/v1/admin/customers", { name, phone, employeeIds: [owner.id] })).json()).customer;
  const aliceCustomer = await customer("Alice Buyer", "9876500001", alice);
  const bobCustomer = await customer("Bob Buyer", "9876500002", bob);
  let sequence = 0;
  const log = async (employee, startedAt, remote) => {
    sequence += 1;
    const id = `log_${sequence}`;
    await f.DB.prepare(
      `INSERT INTO call_logs (id, device_id, employee_id, fingerprint, started_at, duration_seconds, call_type, remote_number, created_at)
       VALUES (?, ?, ?, ?, ?, 60, 'outgoing', ?, ?)`,
    ).bind(id, devices[employee.id], employee.id, sequence.toString(16).padStart(64, "0"), startedAt, remote, startedAt).run();
    return id;
  };
  const recording = async (employee, logId, key) => {
    sequence += 1;
    await f.RECORDINGS.put(key, new TextEncoder().encode(`synthetic audio ${key}`), { httpMetadata: { contentType: "audio/mp4" } });
    await f.DB.prepare(
      `INSERT INTO calls (id, employee_id, device_id, fingerprint, display_name, match_status, object_key, content_type,
         expected_bytes, upload_status, created_at, call_log_id)
       VALUES (?, ?, ?, ?, 'call.m4a', 'call_log', ?, 'audio/mp4', 10, 'complete', '2026-10-12T04:00:00.000Z', ?)`,
    ).bind(`rec_${sequence}`, employee.id, devices[employee.id], `rec-fp-${sequence}`, key, logId).run();
    // Linking is done by triggers on insert; set it explicitly as the real upload flow does.
    await f.DB.prepare("UPDATE calls SET call_log_id = ? WHERE id = ?").bind(logId, `rec_${sequence}`).run();
  };
  const aliceLog = await log(alice, "2026-10-12T04:00:00.000Z", "+919876500001");
  const aliceBareLog = await log(alice, "2026-10-12T05:00:00.000Z", "+919876500009");
  const bobLog = await log(bob, "2026-10-12T04:30:00.000Z", "+919876500002");
  await recording(alice, aliceLog, "recordings/alice.m4a");
  await recording(bob, bobLog, "recordings/bob.m4a");
  const inbound = async (who, id, extra = {}) => {
    const now = new Date().toISOString();
    await f.DB.prepare(
      `INSERT INTO whatsapp_messages (id, customer_id, direction, message_type, body, status, sent_at, source, created_at, media_key, media_mime)
       VALUES (?, ?, 'in', ?, ?, 'delivered', ?, 'import', ?, ?, ?)`,
    ).bind(id, who.id, extra.type ?? "text", extra.body ?? "hello", now, now, extra.key ?? null, extra.mime ?? null).run();
  };
  await inbound(aliceCustomer, "wam_alice_in");
  await inbound(bobCustomer, "wam_bob_in", { type: "image", body: "bob photo", key: "whatsapp-media/wam_bob_in", mime: "image/jpeg" });
  await inbound(aliceCustomer, "wam_alice_img", { type: "image", body: "alice photo", key: "whatsapp-media/wam_alice_img", mime: "image/jpeg" });
  await f.RECORDINGS.put("whatsapp-media/wam_bob_in", jpeg(), { httpMetadata: { contentType: "image/jpeg" } });
  await f.RECORDINGS.put("whatsapp-media/wam_alice_img", jpeg(), { httpMetadata: { contentType: "image/jpeg" } });
  return { alice, bob, aliceCustomer, bobCustomer, aliceLog, aliceBareLog, bobLog };
}

const stripId = ({ requestId: _ignored, ...rest }) => rest;

test("employee web access is off by default and every route except config says so", async (t) => {
  const f = await fixture(t, { enable: false });
  const config = await (await f.web("/v1/web/config")).json();
  assert.deepEqual([config.enabled, config.methods], [false, []]);
  assert.equal((await (await f.admin("GET", "/v1/admin/features")).json()).employeeWeb, false);
  for (const [method, path, body] of [
    ["POST", "/v1/web/auth/request", { email: "a@example.test", method: "email" }],
    ["POST", "/v1/web/auth/verify", { email: "a@example.test", code: "123456" }],
    ["GET", "/v1/web/session"], ["POST", "/v1/web/auth/logout"], ["GET", "/v1/web/customers"], ["GET", "/v1/web/profile"],
  ]) {
    const response = await f.web(path, { method, body });
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).error.code, "web_disabled", path);
  }
});

test("settings report what is missing and refuse to turn access on without a way to sign in", async (t) => {
  const bare = await fixture(t, { env: {}, enable: false });
  const view = (await (await bare.admin("GET", "/v1/admin/settings")).json()).settings.employeeWeb;
  assert.deepEqual([view.enabled, view.emailOtp, view.whatsappOtp, view.whatsappTemplate, view.methods, view.active], [false, true, false, null, [], false]);
  assert.deepEqual(view.usable, { email: false, whatsapp: false });
  assert.equal(view.prerequisites.email.configured, false);
  assert.ok(view.prerequisites.email.missing.includes("domain") && view.prerequisites.email.missing.includes("API key"));
  assert.deepEqual(view.prerequisites.whatsapp.missing, ["access token", "phone number ID", "business account ID", "template"]);
  assert.equal(view.prerequisites.whatsapp.configured, false);
  const refused = await bare.saveWeb({ enabled: true });
  assert.equal(refused.status, 400);
  const refusal = (await refused.json()).error;
  assert.equal(refusal.code, "no_sign_in_method");
  assert.match(refusal.message, /Turn on at least one sign-in method first\. Email code: missing domain/);
  assert.match((await (await bare.saveWeb({ emailOtp: true })).json()).error.message, /Email sign-in needs the email settings/);
  assert.equal((await bare.saveWeb({ whatsappOtp: true })).status, 400);
  assert.equal((await bare.saveWeb({ unknown: true })).status, 400);

  const ready = await fixture(t, { enable: false });
  const saved = await ready.saveWeb({ enabled: true });
  assert.equal(saved.status, 200);
  const savedView = (await saved.json()).settings.employeeWeb;
  assert.deepEqual([savedView.methods, savedView.usable, savedView.active, savedView.prerequisites.email.configured], [["email"], { email: true, whatsapp: false }, true, true]);
  const features = await (await ready.admin("GET", "/v1/admin/features")).json();
  assert.deepEqual([features.employeeWeb, features.employeeWebMethods], [true, ["email"]]);
  assert.deepEqual(await (await ready.web("/v1/web/config")).json().then(stripId), { enabled: true, methods: ["email"] });
  // Switching off the last usable method while access is on is refused; switching both off together is fine.
  const last = await ready.saveWeb({ emailOtp: false });
  assert.equal(last.status, 400);
  assert.equal((await last.json()).error.code, "no_sign_in_method");
  assert.equal((await ready.saveWeb({ emailOtp: false, enabled: false })).status, 200);
  assert.deepEqual(await (await ready.web("/v1/web/config")).json().then(stripId), { enabled: false, methods: [] });
  assert.equal((await ready.saveWeb({ emailOtp: true, enabled: true })).status, 200);
  assert.equal((await ready.saveWeb({ enabled: null })).status, 200);
  assert.equal((await (await ready.web("/v1/web/config")).json()).enabled, false);
});

test("WhatsApp sign-in settings accept only templates that can carry a code", async (t) => {
  const f = await fixture(t, { enable: false });
  assert.equal((await f.saveWeb({ whatsappOtp: true })).status, 400);
  const good = { name: "login_code", language: "en_US", otpParam: 1, otherParams: [{ index: 2, source: "employee_name" }] };
  const rejected = [
    [{ ...good, name: "missing_template" }, /not found/],
    [{ ...good, name: "with_image", otherParams: [] }, /cannot carry a sign-in code/],
    [{ ...good, name: "no_variable", otherParams: [] }, /cannot carry a sign-in code/],
    [{ ...good, otpParam: 3 }, /does not exist/],
    [{ ...good, otherParams: [] }, /needs a value/],
    [{ ...good, otherParams: [{ index: 2, source: "custom" }] }, /needs a value/],
    [{ ...good, otherParams: [{ index: 1, source: "employee_name" }] }, /cannot also be filled/],
    [{ ...good, buttonParam: true }, /Only authentication templates/],
    [{ name: "auth_code", language: "en_US", otpParam: 1, otherParams: [] }, /button parameter/],
  ];
  for (const [template, message] of rejected) {
    const response = await f.saveWeb({ whatsappOtp: true, whatsappTemplate: template });
    assert.equal(response.status, 400, JSON.stringify(template));
    assert.match((await response.json()).error.message, message);
  }
  const normal = await f.saveWeb({ whatsappOtp: true, whatsappTemplate: good });
  assert.equal(normal.status, 200);
  const view = (await normal.json()).settings.employeeWeb;
  assert.deepEqual(view.methods, ["email", "whatsapp"]);
  assert.deepEqual(view.whatsappTemplate, { ...good, sentenceEnabled: false });
  const auth = await f.saveWeb({ whatsappTemplate: { name: "auth_code", language: "en_US", otpParam: 1, otherParams: [], buttonParam: true } });
  assert.equal(auth.status, 200);
  // The picker's template list marks which templates can carry a code, and never offers an authentication template for chat.
  const list = (await (await f.admin("GET", "/v1/admin/whatsapp/templates")).json()).items;
  const byName = Object.fromEntries(list.map((item) => [item.name, item]));
  assert.deepEqual([byName.login_code.otpCapable, byName.auth_code.otpCapable, byName.with_image.otpCapable, byName.no_variable.otpCapable], [true, true, false, false]);
  assert.equal(byName.auth_code.sendable, false);
});

test("an emailed code signs an employee in with a hardened cookie and a CSRF token", async (t) => {
  const f = await fixture(t);
  const alice = await f.createEmployee("Alice Synthetic", { email: "Alice@Example.Test", phoneNumber: "+919800000001" });
  assert.equal(alice.email, "alice@example.test");
  assert.equal(alice.webSessions, 0);
  assert.deepEqual(await (await f.web("/v1/web/config")).json().then(stripId), { enabled: true, methods: ["email"] });

  const asked = await f.web("/v1/web/auth/request", { method: "POST", body: { email: "ALICE@example.test", method: "email" } });
  assert.equal(asked.status, 202);
  const askedBody = await asked.json();
  assert.equal(askedBody.sent, true);
  assert.ok(!JSON.stringify({ ...askedBody, requestId: undefined }).match(/\d{6}/));
  assert.equal(f.mails.length, 1);
  const [mail] = f.mails;
  assert.deepEqual(mail.to, ["alice@example.test"]);
  assert.equal(mail.subject, "Your Linekeep sign-in code");
  assert.match(mail.text, /10 minutes/);
  assert.ok(!/https?:\/\//.test(mail.text + mail.html), "no links in the message");
  assert.ok(mail.url.includes("/v3/mg.example.test/messages"));
  const code = f.lastCode();

  const verified = await f.web("/v1/web/auth/verify", { method: "POST", body: { method: "email", email: "alice@example.test", code } });
  assert.equal(verified.status, 200);
  const cookie = verified.headers.get("set-cookie");
  assert.match(cookie, /^__Host-lk_session=wst_[0-9a-f]{64};/);
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=43200"]) assert.ok(cookie.includes(attribute), attribute);
  assert.ok(!/domain=/i.test(cookie));
  const body = await verified.json();
  assert.deepEqual(body.employee, {
    id: alice.id, name: "Alice Synthetic", phoneNumber: "+919800000001", role: "employee", managerId: null, team: [],
  });
  assert.match(body.csrfToken, /^[0-9a-f]{64}$/);
  assert.ok(Date.parse(body.expiresAt) > Date.now());
  assert.equal(verified.headers.get("cache-control"), "no-store");

  const session = { cookie: cookie.split(";")[0], csrf: body.csrfToken };
  const again = await (await f.web("/v1/web/session", { session })).json();
  assert.deepEqual(stripId(again), stripId(body));
  assert.deepEqual((await (await f.web("/v1/web/profile", { session })).json()).employee, body.employee);
  const listed = (await (await f.admin("GET", "/v1/admin/employees")).json()).items.find((item) => item.id === alice.id);
  assert.equal(listed.webSessions, 1);
});

test("a code works once, dies after five wrong attempts, expires, and a new request replaces it", async (t) => {
  const f = await fixture(t);
  await f.createEmployee("Alice Synthetic", { email: "alice@example.test" });
  const email = "alice@example.test";
  const ask = async () => { await f.resetCooldown(); return f.web("/v1/web/auth/request", { method: "POST", body: { email, method: "email" }, ip: `198.51.100.${Math.floor(Math.random() * 200)}` }); };
  const verify = (code) => f.web("/v1/web/auth/verify", { method: "POST", body: { method: "email", email, code } });
  const wrongFor = (code) => (code === "000000" ? "111111" : "000000");

  await ask();
  let code = f.lastCode();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wrong = await verify(wrongFor(code));
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).error.code, "invalid_code");
  }
  assert.equal((await verify(code)).status, 401, "the right code is dead after five wrong attempts");

  await ask();
  const first = f.lastCode();
  await ask();
  code = f.lastCode();
  if (first !== code) assert.equal((await verify(first)).status, 401, "an older code stops working when a new one is sent");
  assert.equal((await verify(code)).status, 200);
  assert.equal((await verify(code)).status, 401, "single use");

  await ask();
  code = f.lastCode();
  await f.DB.prepare("UPDATE web_login_codes SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await verify(code)).status, 401, "expired");
  assert.equal((await verify("12345")).status, 401);
  assert.equal((await verify("abcdef")).status, 401);
  assert.equal((await f.web("/v1/web/auth/verify", { method: "POST", body: { method: "email", email: "nobody", code: "123456" } })).status, 401);
});

test("requests are capped per address and per client and have a resend cooldown", async (t) => {
  const f = await fixture(t);
  await f.createEmployee("Alice Synthetic", { email: "alice@example.test" });
  const ask = (email, ip) => f.web("/v1/web/auth/request", { method: "POST", body: { email, method: "email" }, ip });

  assert.equal((await ask("alice@example.test", "198.51.100.1")).status, 202);
  const cooling = await ask("alice@example.test", "198.51.100.2");
  assert.equal(cooling.status, 429);
  assert.equal((await cooling.json()).error.code, "rate_limited");
  const wait = Number(cooling.headers.get("retry-after"));
  assert.ok(wait > 0 && wait <= 30, `retry-after ${wait}`);

  for (let index = 2; index <= 5; index += 1) {
    await f.resetCooldown();
    assert.equal((await ask("alice@example.test", `198.51.100.${index + 10}`)).status, 202);
  }
  await f.resetCooldown();
  const capped = await ask("alice@example.test", "198.51.100.99");
  assert.equal(capped.status, 429);
  assert.ok(Number(capped.headers.get("retry-after")) > 30);
  // The cap is per address: another one is unaffected.
  assert.equal((await ask("other@example.test", "198.51.100.98")).status, 202);

  const ip = "192.0.2.50";
  for (let index = 0; index < 30; index += 1) assert.equal((await ask(`person${index}@example.test`, ip)).status, 202, String(index));
  const limited = await ask("person99@example.test", ip);
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get("retry-after"));
});

test("an unknown, inactive or phoneless address looks exactly like a known one", async (t) => {
  const f = await fixture(t);
  await f.createEmployee("Alice Synthetic", { email: "alice@example.test", phoneNumber: "+919800000001" });
  const gone = await f.createEmployee("Gone Synthetic", { email: "gone@example.test" });
  await f.identity.setEmployeeActive(gone.id, false);
  const answers = [];
  for (const [email, method] of [["alice@example.test", "email"], ["nobody@example.test", "email"], ["gone@example.test", "email"], ["alice@example.test", "email"]]) {
    await f.resetCooldown();
    const before = (await f.DB.prepare("SELECT count(*) AS n FROM web_login_codes").first()).n;
    const response = await f.web("/v1/web/auth/request", { method: "POST", body: { email, method }, ip: `198.51.100.${answers.length + 1}` });
    const after = (await f.DB.prepare("SELECT count(*) AS n FROM web_login_codes").first()).n;
    answers.push({ status: response.status, body: stripId(await response.json()) });
    assert.equal(after - before, 1, `${email} writes one row`);
  }
  for (const answer of answers) assert.deepEqual(answer, answers[0]);
  assert.equal(f.mails.length, 2, "only the active employee gets mail");
  // A decoy can never be redeemed, and failures look alike.
  const unknown = await f.web("/v1/web/auth/verify", { method: "POST", body: { method: "email", email: "nobody@example.test", code: "123456" } });
  const known = await f.web("/v1/web/auth/verify", { method: "POST", body: { method: "email", email: "alice@example.test", code: f.lastCode() === "123456" ? "654321" : "123456" } });
  assert.equal(unknown.status, 401);
  assert.deepEqual(stripId(await unknown.json()), stripId(await known.json()));
  // A badly formed address is refused without saying anything about employees.
  assert.equal((await f.web("/v1/web/auth/request", { method: "POST", body: { email: "not-an-email", method: "email" } })).status, 400);
  assert.equal((await f.web("/v1/web/auth/request", { method: "POST", body: { email: "a@example.test", method: "whatsapp" } })).status, 400);
});

test("a deactivated employee or a changed address cannot use a code that was already sent", async (t) => {
  const f = await fixture(t);
  const alice = await f.createEmployee("Alice Synthetic", { email: "alice@example.test" });
  const ask = async () => { await f.resetCooldown(); await f.web("/v1/web/auth/request", { method: "POST", body: { email: "alice@example.test", method: "email" }, ip: `198.51.100.${Math.floor(Math.random() * 200)}` }); return f.lastCode(); };
  let code = await ask();
  await f.identity.setEmployeeActive(alice.id, false);
  assert.equal((await f.web("/v1/web/auth/verify", { method: "POST", body: { method: "email", email: "alice@example.test", code } })).status, 401);
  await f.identity.setEmployeeActive(alice.id, true);
  code = await ask();
  assert.equal((await f.admin("PATCH", `/v1/admin/employees/${alice.id}`, { email: "new@example.test" })).status, 200);
  assert.equal((await f.web("/v1/web/auth/verify", { method: "POST", body: { method: "email", email: "alice@example.test", code } })).status, 401);
});

test("the code never reaches logs, the database or a stored message", async (t) => {
  const f = await fixture(t);
  await f.createEmployee("Alice Synthetic", { email: "alice@example.test" });
  const session = await f.signIn("alice@example.test");
  await f.web("/v1/web/session", { session });
  const token = session.cookie.split("=")[1];
  const everything = JSON.stringify({
    logs: f.logs,
    codes: (await f.DB.prepare("SELECT * FROM web_login_codes").all()).results,
    sessions: (await f.DB.prepare("SELECT * FROM web_sessions").all()).results,
    counters: (await f.DB.prepare("SELECT * FROM web_rate_counters").all()).results,
    settings: (await f.DB.prepare("SELECT * FROM app_settings").all()).results,
    messages: (await f.DB.prepare("SELECT * FROM whatsapp_messages").all()).results,
  });
  assert.ok(!everything.includes(session.code), "code");
  assert.ok(!everything.includes(token), "session token");
  assert.ok(!everything.includes("alice@example.test"), "address");
  const hash = (await f.DB.prepare("SELECT code_hash FROM web_login_codes").first()).code_hash;
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM whatsapp_messages").first()).n, 0);

  // The development echo is inert unless the Worker runs on localhost with ENVIRONMENT=development and the flag.
  const production = await fixture(t, { env: { ...mailEnv, WEB_OTP_DEV_LOG: "true", ENVIRONMENT: "production" }, enable: false });
  await production.identity.createEmployee({ name: "Alice Synthetic", email: "alice@example.test" });
  await production.DB.prepare("INSERT INTO app_settings (key, value, encrypted, updated_at) VALUES ('employeeWeb.enabled', 'true', 0, '2026-01-01T00:00:00.000Z')").run();
  assert.equal((await production.web("/v1/web/auth/request", { method: "POST", body: { email: "alice@example.test", method: "email" } })).status, 202);
  assert.ok(!production.logs.join("\n").includes(production.lastCode()));
  const local = await fixture(t, { env: { ...mailEnv, WEB_OTP_DEV_LOG: "true" } });
  await local.createEmployee("Alice Synthetic", { email: "alice@example.test" });
  await local.web("/v1/web/auth/request", { method: "POST", body: { email: "alice@example.test", method: "email" } });
  assert.ok(local.logs.join("\n").includes(local.lastCode()), "the local development echo works when asked for");
});

test("a WhatsApp code goes through the chosen template to the stored phone number, found by phone", async (t) => {
  const f = await fixture(t);
  await f.createEmployee("Alice Synthetic", { email: "alice@example.test", phoneNumber: "+919800000001" });
  const saved = await f.saveWeb({ whatsappOtp: true, whatsappTemplate: { name: "login_code", language: "en_US", otpParam: 1, otherParams: [{ index: 2, source: "employee_name" }] } });
  assert.equal(saved.status, 200);
  assert.deepEqual((await (await f.web("/v1/web/config")).json()).methods, ["email", "whatsapp"]);

  const asked = await f.web("/v1/web/auth/request", { method: "POST", body: { method: "whatsapp", phone: "98000 00001" } });
  assert.equal(asked.status, 202);
  assert.equal(f.mails.length, 0);
  assert.equal(f.sends.length, 1);
  const [sent] = f.sends;
  assert.match(sent.url, /\/1000000000000001\/messages$/);
  assert.equal(sent.body.to, "919800000001");
  const parameters = sent.body.template.components.find((item) => item.type === "body").parameters;
  assert.match(parameters[0].text, /^\d{6}$/);
  assert.equal(parameters[1].text, "Alice Synthetic");
  assert.equal(sent.body.template.components.some((item) => item.type === "button"), false);
  const code = parameters[0].text;
  const verified = await f.web("/v1/web/auth/verify", { method: "POST", body: { method: "whatsapp", phone: "+91 98000 00001", code } });
  assert.equal(verified.status, 200);
  assert.equal((await verified.json()).employee.name, "Alice Synthetic");
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM whatsapp_messages").first()).n, 0);
  assert.ok(!f.logs.join("\n").includes(code));

  // The code goes to the number the admin stored, not to what was typed: another country code with the same
  // last ten digits finds the employee, and the message still goes to the stored +91 number.
  await f.resetCooldown();
  assert.equal((await f.web("/v1/web/auth/request", { method: "POST", body: { method: "whatsapp", phone: "+1 9800000001" }, ip: "198.51.100.8" })).status, 202);
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends.at(-1).body.to, "919800000001");

  // Malformed input and the wrong key for the method are refused before anything is looked up.
  for (const body of [{ method: "whatsapp", phone: "abc" }, { method: "whatsapp", email: "alice@example.test" }, { method: "email", phone: "9800000001" }, { method: "sms", phone: "9800000001" }]) {
    assert.equal((await f.web("/v1/web/auth/request", { method: "POST", body, ip: "198.51.100.9" })).status, 400, JSON.stringify(body));
  }

  // An authentication template also gets the code as its button parameter.
  assert.equal((await f.saveWeb({ whatsappTemplate: { name: "auth_code", language: "en_US", otpParam: 1, otherParams: [], buttonParam: true } })).status, 200);
  await f.resetCooldown();
  await f.web("/v1/web/auth/request", { method: "POST", body: { method: "whatsapp", phone: "9800000001" }, ip: "198.51.100.7" });
  const auth = f.sends.at(-1).body.template;
  assert.equal(auth.name, "auth_code");
  const authCode = auth.components.find((item) => item.type === "body").parameters[0].text;
  assert.match(authCode, /^\d{6}$/);
  assert.deepEqual(auth.components.find((item) => item.type === "button"), {
    type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: authCode }],
  });
});

/** Employees: A (phone), B (phone), C1 and C2 sharing a phone, D (no phone), E (inactive, has a phone). */
async function phoneWorld(f) {
  const make = (name, extra) => f.createEmployee(name, { email: `${name.toLowerCase()}@example.test`, ...extra });
  const a = await make("A", { phoneNumber: "+919800000001" });
  const b = await make("B", { phoneNumber: "+919800000002" });
  const c1 = await make("C1", { phoneNumber: "+919800000003" });
  const c2 = await make("C2");
  await f.DB.prepare("UPDATE employees SET phone_number = '+919800000003' WHERE id = ?").bind(c2.id).run();
  const d = await make("D");
  const e = await make("E", { phoneNumber: "+919800000005" });
  await f.identity.setEmployeeActive(e.id, false);
  assert.equal((await f.saveWeb({ whatsappOtp: true, whatsappTemplate: { name: "login_code", language: "en_US", otpParam: 1, otherParams: [{ index: 2, source: "employee_name" }] } })).status, 200);
  return { a, b, c1, c2, d, e };
}

test("unknown, shared, phoneless, inactive and undeliverable phone numbers all look like a real one", async (t) => {
  const f = await fixture(t);
  await phoneWorld(f);
  const answers = [];
  for (const phone of ["9800000001", "9800000099", "9800000003", "9800000005", "+44 7700 900123"]) {
    await f.resetCooldown();
    const before = (await f.DB.prepare("SELECT count(*) AS n FROM web_login_codes").first()).n;
    const response = await f.web("/v1/web/auth/request", { method: "POST", body: { method: "whatsapp", phone }, ip: `198.51.100.${answers.length + 1}` });
    const after = (await f.DB.prepare("SELECT count(*) AS n FROM web_login_codes").first()).n;
    answers.push({ status: response.status, body: stripId(await response.json()) });
    assert.equal(after - before, 1, `${phone} writes one row`);
  }
  for (const answer of answers) assert.deepEqual(answer, answers[0]);
  assert.equal(f.sends.length, 1, "only the one active employee with that number is messaged");
  assert.equal(f.sends[0].body.to, "919800000001");
  // None of the decoys can be redeemed, whatever code is tried.
  for (const phone of ["9800000099", "9800000003", "9800000005"]) {
    const failure = await f.web("/v1/web/auth/verify", { method: "POST", body: { method: "whatsapp", phone, code: "123456" } });
    assert.equal(failure.status, 401);
    assert.equal((await failure.json()).error.code, "invalid_code");
  }
  // A number WhatsApp cannot deliver to still answers the same, and nothing from Meta is exposed or logged.
  f.state.failSends = true;
  await f.resetCooldown();
  const undeliverable = await f.web("/v1/web/auth/request", { method: "POST", body: { method: "whatsapp", phone: "9800000002" }, ip: "198.51.100.77" });
  assert.deepEqual({ status: undeliverable.status, body: stripId(await undeliverable.json()) }, answers[0]);
  assert.ok(!f.logs.join("\n").includes("secret provider text"));
  assert.match(f.logs.join("\n"), /"event":"web_sign_in_code","method":"whatsapp","delivered":false,"reason":"rejected"/);
});

test("a shared phone number cannot sign in even with a code that was issued before it became shared", async (t) => {
  const f = await fixture(t);
  const w = await phoneWorld(f);
  await f.web("/v1/web/auth/request", { method: "POST", body: { method: "whatsapp", phone: "9800000002" } });
  const code = f.sends.at(-1).body.template.components.find((item) => item.type === "body").parameters[0].text;
  await f.DB.prepare("UPDATE employees SET phone_number = '+919800000002' WHERE id = ?").bind(w.d.id).run();
  assert.equal((await f.web("/v1/web/auth/verify", { method: "POST", body: { method: "whatsapp", phone: "9800000002", code } })).status, 401);
});

test("a code only works for the method and identifier it was issued for", async (t) => {
  const f = await fixture(t);
  const w = await phoneWorld(f);
  const waCode = () => f.sends.at(-1).body.template.components.find((item) => item.type === "body").parameters[0].text;
  const verify = (body) => f.web("/v1/web/auth/verify", { method: "POST", body });
  const askEmail = async (email) => { await f.resetCooldown(); await f.web("/v1/web/auth/request", { method: "POST", body: { method: "email", email }, ip: `198.51.100.${Math.floor(Math.random() * 200)}` }); return f.lastCode(); };
  const askPhone = async (phone) => { await f.resetCooldown(); await f.web("/v1/web/auth/request", { method: "POST", body: { method: "whatsapp", phone }, ip: `198.51.100.${Math.floor(Math.random() * 200)}` }); return waCode(); };

  // An emailed code is no good for WhatsApp sign-in as the same person, or as anyone else.
  const emailCode = await askEmail("a@example.test");
  assert.equal((await verify({ method: "whatsapp", phone: w.a.phoneNumber, code: emailCode })).status, 401);
  assert.equal((await verify({ method: "email", email: "b@example.test", code: emailCode })).status, 401);
  assert.equal((await verify({ method: "email", email: "a@example.test", code: emailCode })).status, 200);

  // And the other way round.
  const phoneCode = await askPhone("9800000001");
  assert.equal((await verify({ method: "email", email: "a@example.test", code: phoneCode })).status, 401);
  assert.equal((await verify({ method: "whatsapp", phone: w.b.phoneNumber, code: phoneCode })).status, 401);
  assert.equal((await verify({ method: "whatsapp", phone: "9800000001", code: phoneCode })).status, 200);

  // The method is stored with the code: an email-method code cannot be spent through the phone key either.
  const rows = (await f.DB.prepare("SELECT method FROM web_login_codes ORDER BY created_at").all()).results.map((row) => row.method);
  assert.deepEqual(rows, ["email", "whatsapp"]);
  assert.equal((await verify({ method: "whatsapp", email: "a@example.test", code: phoneCode })).status, 400);
});

test("phone numbers are unique among active employees, and older clashes are flagged, not broken", async (t) => {
  const f = await fixture(t, { enable: false });
  const create = (name, phoneNumber) => f.admin("POST", "/v1/admin/employees", { name, phoneNumber });
  const alice = (await (await create("Alice", "+919800000001")).json()).employee;
  assert.equal(alice.phoneShared, false);
  for (const phone of ["9800000001", "+91 98000 00001", "+919800000001"]) {
    const clash = await create("Other", phone);
    assert.equal(clash.status, 409, phone);
    assert.equal((await clash.json()).error.code, "employee_phone_exists");
  }
  const bob = (await (await create("Bob", "+919800000002")).json()).employee;
  const patch = (id, body) => f.admin("PATCH", `/v1/admin/employees/${id}`, body);
  const refused = await patch(bob.id, { phoneNumber: "9800000001" });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, "employee_phone_exists");
  assert.equal((await patch(bob.id, { phoneNumber: "9800000002", name: "Bob again" })).status, 200, "his own number again");

  // Data that is already shared keeps working: it is shown as a clash, and unrelated edits still succeed.
  await f.DB.prepare("UPDATE employees SET phone_number = '+919800000001' WHERE id = ?").bind(bob.id).run();
  const listed = (await (await f.admin("GET", "/v1/admin/employees")).json()).items;
  assert.deepEqual(listed.map((item) => [item.name, item.phoneShared]).sort(), [["Alice", true], ["Bob again", true]]);
  assert.equal((await patch(bob.id, { name: "Bob renamed", phoneNumber: "9800000001" })).status, 200);
  assert.equal((await patch(bob.id, { phoneNumber: "9800000003" })).status, 200);
  assert.equal((await (await f.admin("GET", "/v1/admin/employees")).json()).items.every((item) => item.phoneShared === false), true);

  // An inactive employee's number is free to reuse.
  await f.identity.setEmployeeActive(alice.id, false);
  assert.equal((await create("Carol", "+919800000001")).status, 201);
});

test("with no usable method the web app is off even when the stored switch is on", async (t) => {
  const f = await fixture(t, { env: {}, enable: false });
  await f.DB.prepare("INSERT INTO app_settings (key, value, encrypted, updated_at) VALUES ('employeeWeb.enabled', 'true', 0, '2026-01-01T00:00:00.000Z')").run();
  await f.identity.createEmployee({ name: "Alice", email: "alice@example.test", phoneNumber: "+919800000001" });
  assert.deepEqual(await (await f.web("/v1/web/config")).json().then(stripId), { enabled: false, methods: [] });
  for (const [method, path, body] of [
    ["POST", "/v1/web/auth/request", { method: "email", email: "alice@example.test" }],
    ["POST", "/v1/web/auth/verify", { method: "whatsapp", phone: "9800000001", code: "123456" }],
    ["GET", "/v1/web/session"], ["GET", "/v1/web/customers"],
  ]) {
    const response = await f.web(path, { method, body });
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).error.code, "web_disabled", path);
  }
  const view = (await (await f.admin("GET", "/v1/admin/settings")).json()).settings.employeeWeb;
  assert.deepEqual([view.enabled, view.active, view.usable, view.methods], [true, false, { email: false, whatsapp: false }, []]);
  const features = await (await f.admin("GET", "/v1/admin/features")).json();
  assert.deepEqual([features.employeeWeb, features.employeeWebMethods], [false, []]);
  assert.equal((await f.saveWeb({ enabled: true })).status, 400);
});

test("phone requests have the same cooldown and hourly cap as email", async (t) => {
  const f = await fixture(t);
  await phoneWorld(f);
  const ask = (phone, ip) => f.web("/v1/web/auth/request", { method: "POST", body: { method: "whatsapp", phone }, ip });
  assert.equal((await ask("9800000001", "198.51.100.1")).status, 202);
  const cooling = await ask("+91 9800000001", "198.51.100.2");
  assert.equal(cooling.status, 429);
  assert.ok(Number(cooling.headers.get("retry-after")) > 0);
  for (let index = 2; index <= 5; index += 1) {
    await f.resetCooldown();
    assert.equal((await ask("9800000001", `198.51.100.${index + 10}`)).status, 202);
  }
  await f.resetCooldown();
  assert.equal((await ask("9800000001", "198.51.100.99")).status, 429);
  // The cap is per number, and an unknown number is limited the same way.
  assert.equal((await ask("9800000002", "198.51.100.98")).status, 202);
  for (let index = 0; index < 5; index += 1) { await f.resetCooldown(); assert.equal((await ask("9800000077", `198.51.100.${index + 120}`)).status, 202); }
  await f.resetCooldown();
  assert.equal((await ask("9800000077", "198.51.100.140")).status, 429);
});

test("sessions need the cookie, the CSRF header and a same-origin browser for every change", async (t) => {
  const f = await fixture(t);
  const w = await world(f);
  const session = await f.signIn("alice@example.test");
  const patch = (options) => f.web(`/v1/web/customers/${w.aliceCustomer.id}`, { method: "PATCH", body: { notes: "note" }, ...options });

  assert.equal((await f.web("/v1/web/customers")).status, 401);
  assert.equal((await f.web("/v1/web/customers", { session: { cookie: "__Host-lk_session=wst_nope", csrf: "x" } })).status, 401);
  assert.equal((await f.web("/v1/web/customers", { headers: { Cookie: "other=1" } })).status, 401);
  assert.equal((await f.web("/v1/web/anything/else")).status, 401);
  assert.equal((await f.web("/v1/web/customers", { session })).status, 200);

  for (const options of [{ csrf: null }, { csrf: "0".repeat(64) }, { csrf: "" }]) {
    const refused = await patch({ session, ...options });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error.code, "csrf_invalid");
  }
  for (const headers of [{ Origin: "https://evil.example" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }]) {
    assert.equal((await patch({ session, headers })).status, 403, JSON.stringify(headers));
  }
  assert.equal((await patch({ session, headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" } })).status, 200);
  // Another employee's token does not unlock this session.
  const other = await f.signIn("bob@example.test");
  assert.equal((await patch({ session, csrf: other.csrf })).status, 403);
  // Reading is not blocked by site headers, and sign-in itself refuses a cross-site page.
  assert.equal((await f.web("/v1/web/customers", { session, headers: { "Sec-Fetch-Site": "cross-site" } })).status, 200);
  assert.equal((await f.web("/v1/web/auth/request", { method: "POST", body: { email: "alice@example.test", method: "email" }, headers: { Origin: "https://evil.example" } })).status, 403);
});

test("logout needs the CSRF header, clears the cookie and ends the session", async (t) => {
  const f = await fixture(t);
  await world(f);
  const session = await f.signIn("alice@example.test");
  assert.equal((await f.web("/v1/web/auth/logout", { method: "POST", session, csrf: null })).status, 403);
  assert.equal((await f.web("/v1/web/session", { session })).status, 200);
  const out = await f.web("/v1/web/auth/logout", { method: "POST", session });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie"), /^__Host-lk_session=; Max-Age=0;/);
  assert.equal((await f.web("/v1/web/session", { session })).status, 401);
  const stale = await f.web("/v1/web/auth/logout", { method: "POST", session });
  assert.equal(stale.status, 200);
  assert.equal((await f.web("/v1/web/auth/logout", { method: "POST" })).status, 200);
});

test("sessions expire after two idle hours or twelve hours in total, and idle time slides", async (t) => {
  const f = await fixture(t);
  await world(f);
  const session = await f.signIn("alice@example.test");
  const row = () => f.DB.prepare("SELECT * FROM web_sessions").first();
  const created = await row();
  assert.equal(Date.parse(created.expires_at) - Date.parse(created.created_at), 12 * 60 * 60 * 1000);
  assert.equal(Date.parse(created.idle_expires_at) - Date.parse(created.created_at), 2 * 60 * 60 * 1000);

  // Used again after a while: the idle deadline moves out; the 12 hour limit does not.
  const ago = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const soon = new Date(Date.now() + 60 * 1000).toISOString();
  await f.DB.prepare("UPDATE web_sessions SET last_seen_at = ?, idle_expires_at = ?").bind(ago, soon).run();
  const body = await (await f.web("/v1/web/session", { session })).json();
  const slid = await row();
  assert.ok(Date.parse(slid.idle_expires_at) - Date.now() > 100 * 60 * 1000);
  assert.equal(slid.expires_at, created.expires_at);
  assert.ok(Date.parse(body.expiresAt) <= Date.parse(created.expires_at));

  const nearEnd = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await f.DB.prepare("UPDATE web_sessions SET expires_at = ?, last_seen_at = ?").bind(nearEnd, ago).run();
  assert.equal(Date.parse((await (await f.web("/v1/web/session", { session })).json()).expiresAt), Date.parse(nearEnd));

  await f.DB.prepare("UPDATE web_sessions SET idle_expires_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await f.web("/v1/web/session", { session })).status, 401, "idle");
  await f.DB.prepare("UPDATE web_sessions SET idle_expires_at = '2999-01-01T00:00:00.000Z', expires_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await f.web("/v1/web/session", { session })).status, 401, "absolute");
});

test("deactivating, signing out everywhere, changing the address or turning the feature off ends sessions", async (t) => {
  const f = await fixture(t);
  const w = await world(f);
  const alice = await f.signIn("alice@example.test");
  const alice2 = await f.signIn("alice@example.test");
  const bob = await f.signIn("bob@example.test");
  const count = async (id) => (await (await f.admin("GET", "/v1/admin/employees")).json()).items.find((item) => item.id === id).webSessions;
  assert.equal(await count(w.alice.id), 2);

  const out = await f.admin("DELETE", `/v1/admin/employees/${w.alice.id}/web-sessions`);
  assert.equal(out.status, 200);
  assert.equal((await out.json()).revoked, 2);
  assert.equal(await count(w.alice.id), 0);
  for (const session of [alice, alice2]) assert.equal((await f.web("/v1/web/session", { session })).status, 401);
  assert.equal((await f.web("/v1/web/session", { session: bob })).status, 200, "other employees stay signed in");
  assert.equal((await f.admin("DELETE", "/v1/admin/employees/emp_missing/web-sessions")).status, 404);
  assert.equal((await f.request(`/v1/admin/employees/${w.bob.id}/web-sessions`, { method: "DELETE" })).status, 401);

  await f.identity.setEmployeeActive(w.bob.id, false);
  assert.equal((await f.web("/v1/web/session", { session: bob })).status, 401, "deactivated");
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM web_sessions WHERE employee_id = ?").bind(w.bob.id).first()).n, 0);
  await f.identity.setEmployeeActive(w.bob.id, true);

  const again = await f.signIn("alice@example.test");
  assert.equal((await f.admin("PATCH", `/v1/admin/employees/${w.alice.id}`, { name: "Alice Renamed" })).status, 200);
  assert.equal((await f.web("/v1/web/session", { session: again })).status, 200, "a rename keeps the session");
  assert.equal((await f.admin("PATCH", `/v1/admin/employees/${w.alice.id}`, { email: "alice@example.test" })).status, 200);
  assert.equal((await f.web("/v1/web/session", { session: again })).status, 200, "the same address keeps the session");
  assert.equal((await f.admin("PATCH", `/v1/admin/employees/${w.alice.id}`, { email: null })).status, 200);
  assert.equal((await f.web("/v1/web/session", { session: again })).status, 401, "clearing the address");

  const last = await f.signIn("bob@example.test");
  assert.equal((await f.saveWeb({ enabled: false })).status, 200);
  assert.equal((await f.web("/v1/web/session", { session: last })).status, 404);
  assert.equal((await f.web("/v1/web/customers", { session: last })).status, 404);
  assert.equal((await f.saveWeb({ enabled: true })).status, 200);
  assert.equal((await f.web("/v1/web/session", { session: last })).status, 200, "the session itself survived, only the feature was off");
});

test("employee emails are validated, lower-cased and unique", async (t) => {
  const f = await fixture(t, { enable: false });
  const one = await f.admin("POST", "/v1/admin/employees", { name: "One", email: " One@Example.Test " });
  assert.equal(one.status, 201);
  const employee = (await one.json()).employee;
  assert.equal(employee.email, "one@example.test");
  assert.equal((await f.admin("POST", "/v1/admin/employees", { name: "Plain" })).status, 201);
  assert.equal((await f.admin("POST", "/v1/admin/employees", { name: "Null", email: null })).status, 201);
  assert.equal((await f.admin("POST", "/v1/admin/employees", { name: "Bad", email: "nope" })).status, 400);
  const duplicate = await f.admin("POST", "/v1/admin/employees", { name: "Two", email: "ONE@example.test" });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, "employee_email_exists");
  const two = (await (await f.admin("POST", "/v1/admin/employees", { name: "Two", email: "two@example.test" })).json()).employee;
  assert.equal((await f.admin("PATCH", `/v1/admin/employees/${two.id}`, { email: "One@example.test" })).status, 409);
  assert.equal((await f.admin("PATCH", `/v1/admin/employees/${two.id}`, { email: "" })).status, 400);
  const cleared = await f.admin("PATCH", `/v1/admin/employees/${two.id}`, { email: null });
  assert.equal((await cleared.json()).employee.email, null);
  assert.equal((await f.admin("PATCH", `/v1/admin/employees/${two.id}`, { email: "one@example.test" })).status, 409);
  assert.equal((await f.admin("PATCH", `/v1/admin/employees/${employee.id}`, { name: "One renamed" })).status, 200);
  assert.equal((await f.request("/v1/admin/employees", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x", email: "x@example.test" }) })).status, 401);
});

test("an employee sees and changes only their own customers, chats and calls", async (t) => {
  const f = await fixture(t);
  const w = await world(f);
  const alice = await f.signIn("alice@example.test");
  const get = (path, session = alice) => f.web(path, { session });

  const customers = (await (await get("/v1/web/customers")).json()).items;
  assert.deepEqual(customers.map((item) => item.id), [w.aliceCustomer.id]);
  assert.equal((await get(`/v1/web/customers/${w.aliceCustomer.id}`)).status, 200);
  assert.equal((await get(`/v1/web/customers/${w.bobCustomer.id}`)).status, 404);
  assert.equal((await get(`/v1/web/customers/${w.bobCustomer.id}/messages`)).status, 404);
  assert.equal((await get(`/v1/web/customers/${w.bobCustomer.id}/calls`)).status, 404);
  const lookup = await (await get("/v1/web/customers/lookup?phone=9876500002")).json();
  assert.equal(lookup.customer, undefined);
  assert.ok(!JSON.stringify(lookup).includes("Bob Buyer"));
  assert.ok(!JSON.stringify(customers).includes("Bob"));

  // Only name and notes change; the phone, assignment and deletion are not available.
  const patch = (customer, body) => f.web(`/v1/web/customers/${customer.id}`, { method: "PATCH", session: alice, body });
  const edited = await patch(w.aliceCustomer, { name: "Alice Buyer 2", notes: "likes email" });
  assert.equal(edited.status, 200);
  assert.deepEqual([(await edited.json()).customer.name], ["Alice Buyer 2"]);
  assert.equal((await patch(w.aliceCustomer, { phone: "9876599999" })).status, 400);
  assert.equal((await patch(w.aliceCustomer, { employeeIds: [w.bob.id] })).status, 400);
  assert.equal((await patch(w.aliceCustomer, { source: "x" })).status, 400);
  assert.equal((await patch(w.bobCustomer, { name: "Hijack" })).status, 404);
  assert.equal((await f.DB.prepare("SELECT name FROM customers WHERE id = ?").bind(w.bobCustomer.id).first()).name, "Bob Buyer");
  for (const [method, path] of [
    ["DELETE", `/v1/web/customers/${w.aliceCustomer.id}`], ["PUT", `/v1/web/customers/${w.aliceCustomer.id}/employees`],
    ["POST", "/v1/web/customers/bulk"], ["DELETE", "/v1/web/call-history/" + w.aliceLog], ["DELETE", "/v1/web/call-logs/" + w.aliceLog],
    ["POST", "/v1/web/whatsapp/auto-replies"], ["GET", "/v1/web/whatsapp/config"], ["PUT", "/v1/web/whatsapp/quick-messages"],
    ["GET", "/v1/web/employees"], ["GET", "/v1/web/devices"], ["GET", "/v1/web/settings"], ["GET", "/v1/web/calls"],
    ["PUT", "/v1/web/push-token"], ["POST", "/v1/web/uploads/prepare"], ["POST", "/v1/web/call-logs/batch"],
  ]) {
    const response = await f.web(path, { method, session: alice, body: method === "GET" ? undefined : {} });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  // The employee can add a customer of their own, and an existing number is not disclosed.
  const added = await f.web("/v1/web/customers", { method: "POST", session: alice, body: { name: "New Lead", phone: "9876500003" } });
  assert.equal(added.status, 201);
  const clash = await f.web("/v1/web/customers", { method: "POST", session: alice, body: { name: "Dup", phone: "9876500002" } });
  assert.equal(clash.status, 409);
  assert.ok(!JSON.stringify(await clash.json()).includes(w.bobCustomer.id));

  const calls = (await (await get("/v1/web/call-history")).json()).items;
  assert.deepEqual(calls.map((item) => item.id).sort(), [w.aliceBareLog, w.aliceLog].sort());
  assert.ok(calls.every((item) => item.employee.id === w.alice.id));
  assert.deepEqual(calls.find((item) => item.id === w.aliceLog).customer, { id: w.aliceCustomer.id, name: "Alice Buyer 2" });
  assert.equal((await get(`/v1/web/call-history?employeeId=${w.bob.id}`)).status, 400);
  const withCustomer = (await (await get(`/v1/web/customers/${w.aliceCustomer.id}/calls`)).json()).items;
  assert.deepEqual(withCustomer.map((item) => item.id), [w.aliceLog]);
  const analytics = await (await get("/v1/web/analytics?from=2026-10-12&to=2026-10-12")).json();
  assert.equal(analytics.totals.total, 2);
  assert.deepEqual(analytics.employees.map((item) => item.id), [w.alice.id]);
  assert.equal((await get(`/v1/web/analytics?employeeIds=${w.bob.id}`)).status, 400);

  const chats = (await (await get("/v1/web/whatsapp/chats")).json()).items;
  assert.deepEqual(chats.map((item) => item.customer.id), [w.aliceCustomer.id]);
  const messages = (await (await get(`/v1/web/customers/${w.aliceCustomer.id}/messages`)).json()).items;
  assert.ok(messages.every((item) => !item.media || item.media.url.startsWith("/v1/web/whatsapp/messages/")));
  assert.deepEqual((await (await get("/v1/web/whatsapp/status")).json()).canSend, true);
  assert.equal((await get("/v1/web/whatsapp/version")).status, 200);
  assert.equal((await get("/v1/web/whatsapp/quick-messages")).status, 200);
  const unread = await (await get("/v1/web/whatsapp/unread")).json();
  assert.ok(unread.messages >= 0 && unread.messages <= 2);
  assert.equal((await f.web(`/v1/web/whatsapp/chats/${w.aliceCustomer.id}/read`, { method: "POST", session: alice })).status, 200);
  assert.equal((await f.web(`/v1/web/whatsapp/chats/${w.bobCustomer.id}/read`, { method: "POST", session: alice })).status, 404);
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM whatsapp_chat_reads WHERE customer_id = ?").bind(w.bobCustomer.id).first()).n, 0);

  // Media: own is served with the cookie alone and is revalidated, never reused freely; another employee's is a 404.
  const media = await get("/v1/web/whatsapp/messages/wam_alice_img/media");
  assert.equal(media.status, 200);
  assert.equal(new Uint8Array(await media.arrayBuffer()).length, jpeg().length);
  assert.ok(!(media.headers.get("cache-control") ?? "").includes("max-age"));
  const ranged = await f.web("/v1/web/whatsapp/messages/wam_alice_img/media", { session: alice, headers: { Range: "bytes=0-3" } });
  assert.equal(ranged.status, 206);
  assert.equal((await get("/v1/web/whatsapp/messages/wam_bob_in/media")).status, 404);

  // Admin routes do not answer to a web session, and the admin guard still holds.
  for (const path of ["/v1/admin/employees", "/v1/admin/customers", "/v1/admin/settings", "/v1/admin/calls", "/v1/admin/call-logs"]) {
    const response = await f.request(path, { headers: { Cookie: alice.cookie } });
    assert.equal(response.status, 401, path);
  }
  const bob = await f.signIn("bob@example.test");
  assert.deepEqual((await (await get("/v1/web/customers", bob)).json()).items.map((item) => item.id), [w.bobCustomer.id]);
  assert.ok(!JSON.stringify(await (await get("/v1/web/call-history", bob)).json()).includes("Alice"));
});

test("an employee plays back only their own recording, through a short-lived signed URL", async (t) => {
  const f = await fixture(t);
  const w = await world(f);
  const alice = await f.signIn("alice@example.test");
  const bob = await f.signIn("bob@example.test");
  const history = (await (await f.web("/v1/web/call-history?hasRecording=true", { session: alice })).json()).items;
  assert.deepEqual(history.map((item) => item.id), [w.aliceLog]);
  assert.ok(!JSON.stringify(history).includes("alice.m4a"));

  const playback = await f.web(`/v1/web/call-history/${w.aliceLog}/recording`, { session: alice });
  assert.equal(playback.status, 200);
  const grant = await playback.json();
  assert.equal(grant.contentType, "audio/mp4");
  assert.ok(Date.parse(grant.expiresAt) - Date.now() <= 5 * 60 * 1000 && Date.parse(grant.expiresAt) > Date.now());
  const url = new URL(grant.url);
  assert.equal(url.pathname, `/v1/web/call-history/${w.aliceLog}/recording/audio`);
  assert.ok(url.searchParams.get("signature") && !grant.url.includes("alice.m4a"));

  const audio = await f.web(url.pathname + url.search, { session: alice });
  assert.equal(audio.status, 200);
  assert.equal(await audio.text(), "synthetic audio recordings/alice.m4a");
  const part = await f.web(url.pathname + url.search, { session: alice, headers: { Range: "bytes=0-8" } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), "synthetic");
  assert.equal(part.headers.get("accept-ranges"), "bytes");

  // The link alone is not enough, and it is useless to anyone else or after tampering.
  assert.equal((await f.web(url.pathname + url.search)).status, 401);
  assert.equal((await f.web(url.pathname + url.search, { session: bob })).status, 404);
  assert.equal((await f.web(url.pathname, { session: alice })).status, 401);
  const tampered = new URL(url);
  tampered.searchParams.set("signature", "0".repeat(64));
  assert.equal((await f.web(tampered.pathname + tampered.search, { session: alice })).status, 401);
  const expired = new URL(url);
  expired.searchParams.set("expiresAt", "2000-01-01T00:00:00.000Z");
  assert.equal((await f.web(expired.pathname + expired.search, { session: alice })).status, 401);

  // Someone else's recording, a call without one, an unknown call and a deleted recording are all plain 404s.
  assert.equal((await f.web(`/v1/web/call-history/${w.bobLog}/recording`, { session: alice })).status, 404);
  assert.equal((await f.web(`/v1/web/call-history/${w.aliceBareLog}/recording`, { session: alice })).status, 404);
  assert.equal((await f.web("/v1/web/call-history/log_missing/recording", { session: alice })).status, 404);
  assert.equal((await f.web(`/v1/web/call-history/${w.aliceLog}/recording`)).status, 401);
  await f.DB.prepare("UPDATE calls SET upload_status = 'deleted' WHERE call_log_id = ?").bind(w.aliceLog).run();
  assert.equal((await f.web(`/v1/web/call-history/${w.aliceLog}/recording`, { session: alice })).status, 404);
  // Listening is all there is: no delete or upload verbs exist for recordings.
  assert.equal((await f.web(`/v1/web/call-history/${w.aliceLog}/recording`, { method: "DELETE", session: alice })).status, 404);
});

test("chat attachments and sends stay within the employee's own customers and files", async (t) => {
  const f = await fixture(t);
  const w = await world(f);
  const alice = await f.signIn("alice@example.test");
  const bob = await f.signIn("bob@example.test");
  const upload = (session) => f.web("/v1/web/whatsapp/attachments?fileName=photo.jpg", { method: "POST", session, raw: jpeg(), headers: { "Content-Type": "image/jpeg" } });
  assert.equal((await f.web("/v1/web/whatsapp/attachments", { method: "POST", raw: jpeg(), headers: { "Content-Type": "image/jpeg" } })).status, 401);
  assert.equal((await f.web("/v1/web/whatsapp/attachments", { method: "POST", session: alice, csrf: null, raw: jpeg(), headers: { "Content-Type": "image/jpeg" } })).status, 403);
  const staged = await upload(alice);
  assert.equal(staged.status, 201);
  const { attachmentId } = await staged.json();
  assert.match(attachmentId, /^wat_/);

  const send = (session, customer, body) => f.web(`/v1/web/customers/${customer.id}/messages`, { method: "POST", session, body });
  const attachment = { type: "media", attachmentId, clientMessageId: crypto.randomUUID() };
  assert.equal((await send(bob, w.bobCustomer, attachment)).status, 404, "another employee's staged file");
  assert.equal((await send(alice, w.bobCustomer, { clientMessageId: crypto.randomUUID(), text: "hi" })).status, 404, "another employee's customer");
  assert.equal(f.sends.length, 0);

  const sent = await send(alice, w.aliceCustomer, attachment);
  assert.equal(sent.status, 201);
  const message = (await sent.json()).message;
  assert.equal(message.media.url, `/v1/web/whatsapp/messages/${message.id}/media`);
  assert.equal(f.sends.length, 1);
  const text = await send(alice, w.aliceCustomer, { clientMessageId: crypto.randomUUID(), text: "free text inside the window" });
  assert.equal(text.status, 201);
  assert.equal((await text.json()).message.sentBy?.id ?? w.alice.id, w.alice.id);

  const list = (await (await f.web("/v1/web/whatsapp/templates", { session: alice })).json()).items;
  assert.ok(list.some((item) => item.name === "login_code"));
  assert.equal((await f.web("/v1/web/whatsapp/templates", { session: bob })).status, 200);
  assert.equal((await f.web("/v1/web/whatsapp/templates")).status, 401);
});

test("a full sentence can replace the bare code in the code's variable", async (t) => {
  const f = await fixture(t);
  await f.createEmployee("Alice Synthetic", { email: "alice@example.test", phoneNumber: "+919800000001" });
  const base = { name: "greeting_code", language: "en_US", otpParam: 1, otherParams: [] };
  const save = (extra) => f.saveWeb({ whatsappOtp: true, whatsappTemplate: { ...base, ...extra } });
  const bodyText = () => f.sends.at(-1).body.template.components.find((item) => item.type === "body").parameters[0].text;
  const askPhone = async (ip) => { await f.resetCooldown(); return f.web("/v1/web/auth/request", { method: "POST", body: { method: "whatsapp", phone: "9800000001" }, ip }); };
  const sentence = "Your Linekeep sign-in code is {{code}}. It is valid for 10 minutes. Do not share it with anyone.";

  // Validation: a clear reason for each way Meta would refuse the variable.
  for (const [extra, pattern] of [
    [{ sentenceEnabled: true }, /sentence is empty/],
    [{ sentenceEnabled: true, sentence: "  \n " }, /sentence is empty/],
    [{ sentenceEnabled: true, sentence: "Your code is ready" }, /must contain \{\{code\}\}/],
    [{ sentenceEnabled: true, sentence: "Code {{code}}\nsecond line" }, /line breaks or tabs/],
    [{ sentenceEnabled: true, sentence: "Code\t{{code}}" }, /line breaks or tabs/],
    [{ sentenceEnabled: true, sentence: "Code    {{code}}" }, /four or more spaces/],
    [{ sentenceEnabled: true, sentence: `${"x".repeat(200)} {{code}}` }, /characters; keep it to 200/],
  ]) {
    const refused = await save(extra);
    assert.equal(refused.status, 400, JSON.stringify(extra));
    const { error } = await refused.json();
    assert.equal(error.code, "invalid_sentence");
    assert.match(error.message, pattern);
  }
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM app_settings WHERE key = 'employeeWeb.whatsappTemplate'").first()).n, 0, "nothing was stored");

  // The sentence is trimmed and stored, and returned by GET (it is not secret).
  const saved = await save({ sentenceEnabled: true, sentence: `\n  ${sentence} \n` });
  assert.equal(saved.status, 200);
  const stored = (await saved.json()).settings.employeeWeb.whatsappTemplate;
  assert.deepEqual([stored.sentenceEnabled, stored.sentence], [true, sentence]);
  assert.equal((await askPhone("198.51.100.1")).status, 202);
  const sent = bodyText();
  assert.match(sent, /^Your Linekeep sign-in code is \d{6}\. It is valid for 10 minutes\. Do not share it with anyone\.$/);
  const code = sent.match(/\d{6}/)[0];
  assert.equal(sent, sentence.replace("{{code}}", code));
  assert.equal((await f.web("/v1/web/auth/verify", { method: "POST", body: { method: "whatsapp", phone: "9800000001", code } })).status, 200);

  // The code is never logged, stored or returned by the settings.
  const settingsText = JSON.stringify((await (await f.admin("GET", "/v1/admin/settings")).json()).settings.employeeWeb);
  assert.ok(!settingsText.includes(code));
  assert.ok(!f.logs.join("\n").includes(code));
  assert.ok(!JSON.stringify((await f.DB.prepare("SELECT * FROM app_settings").all()).results).includes(code));
  assert.ok(!JSON.stringify((await f.DB.prepare("SELECT * FROM web_login_codes").all()).results).includes(code));

  // Every {{code}} is replaced.
  assert.equal((await save({ sentenceEnabled: true, sentence: "{{code}} is your code ({{code}})" })).status, 200);
  assert.equal((await askPhone("198.51.100.2")).status, 202);
  assert.match(bodyText(), /^(\d{6}) is your code \(\1\)$/);

  // Off: the bare code, and a leftover sentence is not kept.
  const off = await save({ sentenceEnabled: false, sentence: "ignored {{code}}" });
  assert.equal(off.status, 200);
  const offView = (await off.json()).settings.employeeWeb.whatsappTemplate;
  assert.deepEqual([offView.sentenceEnabled, offView.sentence], [false, undefined]);
  assert.equal((await askPhone("198.51.100.3")).status, 202);
  assert.match(bodyText(), /^\d{6}$/);

  // An authentication template gets the sentence in the body and still the bare code on its button.
  assert.equal((await f.saveWeb({ whatsappTemplate: { name: "auth_code", language: "en_US", otpParam: 1, otherParams: [], buttonParam: true, sentenceEnabled: true, sentence: "Use {{code}} to sign in" } })).status, 200);
  assert.equal((await askPhone("198.51.100.4")).status, 202);
  const auth = f.sends.at(-1).body.template.components;
  const button = auth.find((item) => item.type === "button").parameters[0].text;
  assert.match(button, /^\d{6}$/);
  assert.equal(auth.find((item) => item.type === "body").parameters[0].text, `Use ${button} to sign in`);
});
