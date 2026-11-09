import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { Miniflare } from "miniflare";

import { createDatabase, enableFeatures, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { createIdentityRepository } = await loadModule("./identity.ts");
const adminSecret = "synthetic-bulk-admin-secret-not-for-deployment";
const tokenSecret = "synthetic-bulk-token-secret-not-for-deployment";
const whatsapp = {
  WHATSAPP_TOKEN: "synthetic-token-never-in-responses", WHATSAPP_PHONE_NUMBER_ID: "1000000000000001", WHATSAPP_WABA_ID: "1000000000000002",
  WHATSAPP_APP_SECRET: "synthetic-app-secret", WHATSAPP_VERIFY_TOKEN: "synthetic-verify",
};
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccount = JSON.stringify({
  client_email: "push@linekeep-test.iam.gserviceaccount.com", project_id: "linekeep-test",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);

const templates = [
  { name: "welcome", language: "en_US", status: "APPROVED", category: "UTILITY", components: [
    { type: "BODY", text: "Hi {{1}}, I am {{2}} ({{3}}). {{4}}", example: { body_text: [["a", "b", "c", "d"]] } }] },
  { name: "plain", language: "en_US", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Hi {{1}}", example: { body_text: [["a"]] } }] },
  { name: "with_image", language: "en_US", status: "APPROVED", category: "MARKETING", components: [
    { type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hello {{1}}", example: { body_text: [["a"]] } }] },
  { name: "carousel", language: "en_US", status: "APPROVED", category: "MARKETING", components: [{ type: "CAROUSEL" }, { type: "BODY", text: "x" }] },
];

/** A fake Graph API (and FCM) that counts every outbound call. `fail(sendNumber, body)` can turn a send into a Meta error. */
function stubGraph(t, { fail } = {}) {
  const log = { templates: 0, uploads: 0, sends: [], pushes: [], oauth: 0, total: 0 };
  let media = 0, active = 0;
  log.maxActive = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    log.total += 1;
    if (u.hostname === "oauth2.googleapis.com") { log.oauth += 1; return new Response(JSON.stringify({ access_token: "synthetic-access", expires_in: 3600 }), { status: 200 }); }
    if (u.hostname === "fcm.googleapis.com") {
      const message = JSON.parse(init.body).message;
      log.pushes.push({ token: message.token, data: message.data });
      return new Response("{}", { status: 200 });
    }
    if (u.pathname.endsWith("/message_templates")) {
      log.templates += 1;
      const wanted = u.searchParams.get("name");
      return new Response(JSON.stringify({ data: templates.filter((x) => !wanted || x.name === wanted) }), { status: 200 });
    }
    if (u.pathname.endsWith("/media")) { log.uploads += 1; return new Response(JSON.stringify({ id: String(7000000 + ++media) }), { status: 200 }); }
    active += 1; log.maxActive = Math.max(log.maxActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const body = JSON.parse(init.body);
      log.sends.push(body);
      const failure = fail?.(log.sends.length, body);
      if (failure) return failure;
      return new Response(JSON.stringify({ messages: [{ id: `wamid.BULK${log.sends.length}` }] }), { status: 200 });
    } finally { active -= 1; }
  };
  t.after(() => { globalThis.fetch = original; });
  return log;
}

async function fixture(t, { features = true, extraEnv = whatsapp } = {}) {
  const DB = await createDatabase(t);
  if (features) await enableFeatures(DB);
  const runtime = new Miniflare({
    workers: [{ config: {
      name: "bulk-tests", compatibilityDate: "2026-09-24",
      manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default { fetch() { return new Response(null, { status: 404 }); } }" } } },
      env: { RECORDINGS: { type: "r2", name: "bulk-test-bucket" } },
    } }],
  });
  t.after(() => runtime.dispose());
  const RECORDINGS = await runtime.getR2Bucket("RECORDINGS");
  const identity = createIdentityRepository(DB, tokenSecret);
  const people = {};
  for (const [name, phoneNumber] of [["Alice", "+919000000001"], ["Bob", "+919000000002"], ["Carol", undefined]]) {
    const employee = await identity.createEmployee({ name, ...(phoneNumber ? { phoneNumber } : {}) });
    const enrolled = await identity.redeemInvitation((await identity.createInvitation(employee.id, "2099-01-01T00:00:00Z")).invitationCode, { model: "Synthetic" });
    people[name] = { employee, enrolled };
  }
  const env = { DB, RECORDINGS, TOKEN_HASH_SECRET: tokenSecret, LOCAL_ADMIN_SECRET: adminSecret, ENVIRONMENT: "development", ...extraEnv };
  const app = createApp();
  const request = (path, init = {}) => app.request(new URL(path, "http://127.0.0.1"), init, env);
  const admin = (method, path, body) => request(path, {
    method, headers: { Authorization: `Bearer ${adminSecret}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const bulk = (body) => admin("POST", "/v1/admin/customers/bulk", body);
  const upload = (bytes, contentType) => request("/v1/admin/whatsapp/attachments?fileName=header.jpg", {
    method: "POST", headers: { "Content-Type": contentType, Authorization: `Bearer ${adminSecret}` }, body: bytes });
  const count = async () => (await DB.prepare("SELECT count(*) AS n FROM customers").first()).n;
  const phone = (n) => `+9198000${String(n).padStart(5, "0")}`;
  return { DB, RECORDINGS, identity, people, env, request, admin, bulk, upload, count, phone };
}

const alice = (f) => f.people.Alice.employee.id;
const bob = (f) => f.people.Bob.employee.id;

test("rows are created, assigned, and every other outcome is reported without touching data", async (t) => {
  const f = await fixture(t);
  const existing = (await (await f.admin("POST", "/v1/admin/customers", { name: "Old Name", phone: "9800000001", notes: "keep me", employeeIds: [bob(f)] })).json()).customer;
  const inactive = await f.identity.createEmployee({ name: "Gone" });
  await f.identity.setEmployeeActive(inactive.id, false);
  const rows = [
    { name: "  New   One ", phone: "98000 00002", notes: " first ", employeeId: alice(f) },
    { name: "Two", phone: "+91 98000-00003" },
    { name: "Dup of existing", phone: "+919800000001", employeeId: alice(f) },
    { name: "", phone: "9800000004" },
    { name: "Bad phone", phone: "12ab" },
    { name: "Same as row 0", phone: "0 98000 00002" },
    { name: "Ghost", phone: "9800000005", employeeId: "emp_unknown" },
    { name: "Inactive", phone: "9800000006", employeeId: inactive.id },
    { name: "Short", phone: "123" },
  ];
  const response = await f.bulk({ rows });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.requestId);
  assert.deepEqual(body.results.map((r) => r.status),
    ["created", "created", "exists", "invalid", "invalid", "duplicate_in_request", "invalid", "invalid", "invalid"]);
  assert.deepEqual(body.results.map((r) => r.reason), [undefined, undefined, undefined, "name_required", "invalid_phone", "duplicate_phone", "invalid_employee", "invalid_employee", "invalid_phone"]);
  assert.equal(body.results[0].assigned, true);
  assert.equal(body.results[1].assigned, false);
  assert.deepEqual(body.results[2], { index: 2, status: "exists", customerId: existing.id });
  assert.equal(body.results.some((r) => "intro" in r), false);

  const stored = (await f.DB.prepare("SELECT id, name, phone, notes, source, created_by_employee_id FROM customers ORDER BY created_at, phone").all()).results;
  assert.equal(stored.length, 3);
  const first = stored.find((c) => c.id === body.results[0].customerId);
  assert.deepEqual([first.name, first.phone, first.notes, first.source, first.created_by_employee_id], ["New One", "+919800000002", "first", "Bulk import", null]);
  const untouched = stored.find((c) => c.id === existing.id);
  assert.deepEqual([untouched.name, untouched.notes, untouched.source], ["Old Name", "keep me", null]);
  const links = (await f.DB.prepare("SELECT customer_id, employee_id FROM customer_employees ORDER BY customer_id").all()).results;
  assert.equal(links.length, 2);
  assert.ok(links.some((l) => l.customer_id === first.id && l.employee_id === alice(f)));
  assert.ok(links.some((l) => l.customer_id === existing.id && l.employee_id === bob(f)));

  // The same rows again: everything valid now exists and nothing changes.
  const again = await (await f.bulk({ rows })).json();
  assert.deepEqual(again.results.map((r) => r.status),
    ["exists", "exists", "exists", "invalid", "invalid", "duplicate_in_request", "invalid", "invalid", "invalid"]);
  assert.equal(again.results[0].customerId, body.results[0].customerId);
  assert.equal(await f.count(), 3);
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM customer_employees").first()).n, 2);
});

test("an archived customer's number can be added again, like the unique index allows", async (t) => {
  const f = await fixture(t);
  const old = (await (await f.admin("POST", "/v1/admin/customers", { name: "Archived", phone: "9800000009" })).json()).customer;
  assert.equal((await f.admin("DELETE", `/v1/admin/customers/${old.id}`)).status, 200);
  const body = await (await f.bulk({ rows: [{ name: "Back", phone: "9800000009" }] })).json();
  assert.equal(body.results[0].status, "created");
  assert.notEqual(body.results[0].customerId, old.id);
});

test("a lost race for a number reports exists and leaves nothing half-done", async (t) => {
  const f = await fixture(t);
  // The number appears between the lookup and the batch: simulate with a trigger that inserts it first.
  await f.DB.exec("CREATE TRIGGER race BEFORE INSERT ON customers WHEN NEW.phone_key = '9800000010' AND NEW.source = 'Bulk import' BEGIN SELECT RAISE(IGNORE); END;");
  const body = await (await f.bulk({ rows: [{ name: "Raced", phone: "9800000010", employeeId: alice(f) }, { name: "Fine", phone: "9800000011", employeeId: alice(f) }] })).json();
  assert.equal(body.results[0].status, "invalid");
  assert.equal(body.results[0].reason, "not_saved");
  assert.equal(body.results[1].status, "created");
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM customer_employees").first()).n, 1);
});

test("at most 25 rows per request, with a clear 400 and nothing created", async (t) => {
  const f = await fixture(t);
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ name: `C${i}`, phone: f.phone(i) }));
  const refused = await f.bulk({ rows: rows(26) });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, "too_many_rows");
  assert.equal(await f.count(), 0);
  const ok = await f.bulk({ rows: rows(25) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).results.filter((r) => r.status === "created").length, 25);
  assert.equal((await f.bulk({ rows: [] })).status, 400);
  assert.equal((await f.bulk({ rows: [{ name: "x", phone: "9800000001", extra: 1 }] })).status, 400);
  assert.equal((await f.bulk({})).status, 400);
});

test("only an administrator may use it, and the customers feature gates it", async (t) => {
  const f = await fixture(t);
  const body = JSON.stringify({ rows: [{ name: "A", phone: "9800000001" }] });
  assert.equal((await f.request("/v1/admin/customers/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 401);
  assert.equal((await f.request("/v1/admin/customers/bulk", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" }, body })).status, 401);
  assert.equal((await f.request("/v1/admin/customers/bulk", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.people.Alice.enrolled.deviceToken}` }, body })).status, 401);
  assert.equal(await f.count(), 0);

  const off = await fixture(t, { features: false, extraEnv: {} });
  const refused = await off.bulk({ rows: [{ name: "A", phone: "9800000001" }] });
  assert.equal(refused.status, 404);
  assert.equal((await refused.json()).error.code, "feature_disabled");
  assert.equal(await off.count(), 0);
});

test("the intro needs the WhatsApp feature and a working send configuration, and checks the template before creating anything", async (t) => {
  const log = stubGraph(t);
  const intro = { template: { name: "plain", language: "en_US", params: [{ source: "customer_name" }] } };
  const rows = [{ name: "A", phone: "9800000001" }];

  const noWhatsapp = await fixture(t);
  await noWhatsapp.DB.prepare("UPDATE app_settings SET value = 'false' WHERE key = 'feature.whatsapp'").run();
  const gated = await noWhatsapp.bulk({ rows, intro });
  assert.equal(gated.status, 404);
  assert.equal((await gated.json()).error.code, "feature_disabled");
  assert.equal(await noWhatsapp.count(), 0);
  // Without an intro the customers feature alone is enough.
  assert.equal((await noWhatsapp.bulk({ rows })).status, 200);

  const unconfigured = await fixture(t, { extraEnv: {} });
  const notConfigured = await unconfigured.bulk({ rows, intro });
  assert.equal(notConfigured.status, 503);
  assert.equal((await notConfigured.json()).error.code, "WHATSAPP_NOT_CONFIGURED");
  assert.equal(await unconfigured.count(), 0);
  assert.equal((await unconfigured.bulk({ rows })).status, 200);

  const f = await fixture(t);
  for (const [bad, status] of [
    [{ ...intro, template: { ...intro.template, name: "missing" } }, 404],
    [{ ...intro, template: { ...intro.template, name: "carousel", params: [] } }, 400],
    [{ ...intro, template: { ...intro.template, params: [] } }, 400],
    [{ ...intro, template: { ...intro.template, params: [{ source: "nope" }] } }, 400],
    [{ ...intro, template: { ...intro.template, params: [{ value: "bad\nline" }] } }, 400],
    [{ ...intro, template: { ...intro.template, headerAttachmentId: "wat_unknown" } }, 400],
  ]) {
    assert.equal((await f.bulk({ rows, intro: bad })).status, status, JSON.stringify(bad));
  }
  assert.equal(await f.count(), 0);
  assert.equal(log.sends.length, 0);
});

test("intro messages are sent to created rows only, stored like a normal template send, and a rerun sends nothing", async (t) => {
  const log = stubGraph(t);
  const f = await fixture(t);
  await f.admin("POST", "/v1/admin/customers", { name: "Already Here", phone: "9800000001" });
  const intro = { template: { name: "welcome", language: "en_US", params: [{ source: "customer_name" }, { source: "handler_name" }, { source: "handler_phone" }, { value: "See you soon" }] } };
  const rows = [
    { name: "Asha", phone: "9800000002", employeeId: alice(f) },
    { name: "Already Here", phone: "9800000001", employeeId: alice(f) },
    { name: "No handler", phone: "9800000003" },
    { name: "Bad", phone: "x" },
    { name: "Carol's", phone: "9800000004", employeeId: f.people.Carol.employee.id },
  ];
  const body = await (await f.bulk({ rows, intro })).json();
  assert.deepEqual(body.results.map((r) => r.status), ["created", "exists", "created", "invalid", "created"]);
  assert.deepEqual(body.results[0].intro, { status: "sent" });
  assert.equal(body.results[1].intro, undefined);
  assert.deepEqual(body.results[2].intro, { status: "skipped", reason: "no_handler" });
  assert.equal(body.results[3].intro, undefined);
  // Carol has no phone number, so handler_phone cannot be filled.
  assert.deepEqual(body.results[4].intro, { status: "skipped", reason: "missing_value" });
  assert.equal(log.templates, 1);
  assert.equal(log.sends.length, 1);
  const sent = log.sends[0];
  assert.equal(sent.to, "919800000002");
  assert.equal(sent.type, "template");
  assert.deepEqual(sent.template.components[0].parameters.map((p) => p.text), ["Asha", "Alice", "+919000000001", "See you soon"]);

  const stored = (await f.DB.prepare("SELECT * FROM whatsapp_messages WHERE customer_id = ?").bind(body.results[0].customerId).all()).results;
  assert.equal(stored.length, 1);
  assert.deepEqual([stored[0].direction, stored[0].message_type, stored[0].status, stored[0].template_name, stored[0].to_number, stored[0].sent_by_employee_id, stored[0].source],
    ["out", "template", "sent", "welcome", "+919800000002", null, "app"]);
  assert.equal(stored[0].body, "Hi Asha, I am Alice (+919000000001). See you soon");
  assert.equal(stored[0].external_id, "wamid.BULK1");
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM whatsapp_messages WHERE customer_id IN (?, ?)").bind(body.results[2].customerId, body.results[4].customerId).first()).n, 0);

  const before = log.total;
  const again = await (await f.bulk({ rows, intro })).json();
  assert.deepEqual(again.results.map((r) => r.status), ["exists", "exists", "exists", "invalid", "exists"]);
  assert.equal(again.results.some((r) => "intro" in r), false);
  assert.equal(log.sends.length, 1);
  assert.equal(log.total, before + 1, "only the template lookup is repeated");
});

test("template header: the configured default, an override, and a clear failure when neither exists", async (t) => {
  const log = stubGraph(t);
  const f = await fixture(t);
  const intro = (extra = {}) => ({ template: { name: "with_image", language: "en_US", params: [{ source: "customer_name" }], ...extra } });
  const rows = (start) => [0, 1, 2].map((i) => ({ name: `H${start + i}`, phone: `98000${String(start + i).padStart(5, "0")}` }));

  // No default configured: every created row fails with the same reason, and no send or upload happens.
  const missing = await (await f.bulk({ rows: rows(1), intro: intro() })).json();
  assert.deepEqual(missing.results.map((r) => r.status), ["created", "created", "created"]);
  assert.ok(missing.results.every((r) => r.intro.status === "failed" && r.intro.reason === "header_image_required"));
  assert.equal(log.sends.length, 0);
  assert.equal(log.uploads, 0);
  assert.equal(log.templates, 1);

  const staged = await (await f.upload(jpeg(), "image/jpeg")).json();
  const set = await f.admin("PUT", "/v1/admin/whatsapp/template-images/with_image", { attachmentId: staged.attachmentId });
  assert.equal(set.status, 200);
  log.templates = 0;
  const withDefault = await (await f.bulk({ rows: rows(10), intro: intro() })).json();
  assert.ok(withDefault.results.every((r) => r.intro.status === "sent"));
  assert.equal(log.uploads, 1, "the header file is uploaded to Meta once for the whole batch");
  assert.equal(log.templates, 1);
  assert.ok(log.sends.every((s) => s.template.components[0].type === "header" && s.template.components[0].parameters[0].image.id === "7000001"));
  const message = (await f.DB.prepare("SELECT media_key, media_mime FROM whatsapp_messages WHERE customer_id = ?").bind(withDefault.results[0].customerId).first());
  assert.equal(message.media_mime, "image/jpeg");
  assert.match(message.media_key, /^whatsapp-outbound\//);

  // An override file wins over the default.
  const other = await (await f.upload(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]), "image/png")).json();
  const sendsBefore = log.sends.length;
  const overridden = await (await f.bulk({ rows: rows(20).slice(0, 1), intro: intro({ headerAttachmentId: other.attachmentId }) })).json();
  assert.equal(overridden.results[0].intro.status, "sent");
  assert.equal(log.uploads, 2);
  assert.equal(log.sends.length, sendsBefore + 1);
  assert.equal(log.sends.at(-1).template.components[0].parameters[0].image.id, "7000002");

  // Cached Meta id is reused by the next batch.
  await f.bulk({ rows: rows(30).slice(0, 1), intro: intro() });
  assert.equal(log.uploads, 2);
});

test("a failed send never fails the batch, and Meta's text never reaches the response", async (t) => {
  const secretText = "Meta says: token synthetic-token-never-in-responses is bad (internal detail)";
  const log = stubGraph(t, { fail: (n) => (n === 2 ? new Response(JSON.stringify({ error: { message: secretText, code: 131026 } }), { status: 400 })
    : n === 3 ? new Response(JSON.stringify({ error: { message: secretText, code: 190 } }), { status: 401 })
      : n === 4 ? new Response("upstream down", { status: 503 }) : null) });
  const f = await fixture(t);
  const rows = Array.from({ length: 6 }, (_, i) => ({ name: `S${i}`, phone: f.phone(i) }));
  const response = await f.bulk({ rows, intro: { template: { name: "plain", language: "en_US", params: [{ source: "customer_name" }] } } });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes("Meta says") && !text.includes("synthetic-token") && !text.includes("upstream"), text);
  const body = JSON.parse(text);
  assert.ok(body.results.every((r) => r.status === "created"));
  assert.equal(await f.count(), 6);
  const intros = body.results.map((r) => r.intro);
  assert.equal(intros.filter((i) => i.status === "sent").length, 3);
  assert.deepEqual(intros.filter((i) => i.status === "failed").map((i) => i.reason).sort(), ["not_on_whatsapp", "send_failed", "send_failed"]);
  const statuses = (await f.DB.prepare("SELECT status, count(*) AS n FROM whatsapp_messages GROUP BY status").all()).results;
  assert.deepEqual(Object.fromEntries(statuses.map((s) => [s.status, s.n])), { sent: 3, failed: 3 });
  assert.ok(log.maxActive <= 3 && log.maxActive >= 2, `concurrency ${log.maxActive}`);
});

test("a full request of 25 intro messages stays far below the 50-call limit, even when Meta drops a cached media id", async (t) => {
  let staleOnce = true;
  const log = stubGraph(t, { fail: (_n, body) => {
    if (body.template.components?.[0]?.parameters?.[0]?.image?.id === "999" && staleOnce) {
      return new Response(JSON.stringify({ error: { code: 131053, message: "Media upload error" } }), { status: 400 });
    }
    if (body.template.components?.[0]?.parameters?.[0]?.image?.id === "999") return new Response(JSON.stringify({ error: { code: 131053 } }), { status: 400 });
    return null;
  } });
  const f = await fixture(t, { extraEnv: { ...whatsapp, FCM_SERVICE_ACCOUNT: serviceAccount } });
  for (const name of ["Alice", "Bob"]) {
    assert.equal((await f.request("/v1/device/push-token", { method: "PUT", headers: { Authorization: `Bearer ${f.people[name].enrolled.deviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: `fcm-token-${name}`.padEnd(40, "x") }) })).status, 200);
  }
  const staged = await (await f.upload(jpeg(), "image/jpeg")).json();
  await f.admin("PUT", "/v1/admin/whatsapp/template-images/with_image", { attachmentId: staged.attachmentId });
  // A cached id that Meta refuses.
  await f.DB.prepare("UPDATE whatsapp_attachments SET meta_media_id = '999', meta_phone_number_id = ?, meta_uploaded_at = ? WHERE id = ?")
    .bind(whatsapp.WHATSAPP_PHONE_NUMBER_ID, new Date().toISOString(), staged.attachmentId).run();
  log.total = 0;
  const rows = Array.from({ length: 25 }, (_, i) => ({ name: `M${i}`, phone: f.phone(i), employeeId: i % 2 ? bob(f) : alice(f) }));
  const body = await (await f.bulk({ rows, intro: { template: { name: "with_image", language: "en_US", params: [{ source: "customer_name" }] } } })).json();
  assert.ok(body.results.every((r) => r.intro.status === "sent"), JSON.stringify(body.results.filter((r) => r.intro.status !== "sent")));
  assert.equal(log.uploads, 1, "the stale id is replaced once for everybody");
  assert.ok(log.total <= 45, `external calls: ${log.total}`);
  assert.ok(log.total < 50);
});

test("each assigned employee gets one push per request, in the shape the app understands", async (t) => {
  const log = stubGraph(t);
  const f = await fixture(t, { extraEnv: { ...whatsapp, FCM_SERVICE_ACCOUNT: serviceAccount } });
  const token = (name) => `fcm-token-${name}`.padEnd(40, "x");
  for (const name of ["Alice", "Bob", "Carol"]) {
    await f.request("/v1/device/push-token", { method: "PUT", headers: { Authorization: `Bearer ${f.people[name].enrolled.deviceToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ token: token(name) }) });
  }
  const rows = [
    { name: "P0", phone: f.phone(0), employeeId: alice(f) }, { name: "P1", phone: f.phone(1), employeeId: bob(f) },
    { name: "P2", phone: f.phone(2), employeeId: alice(f) }, { name: "P3", phone: f.phone(3), employeeId: alice(f) },
    { name: "P4", phone: f.phone(4) },
  ];
  const body = await (await f.bulk({ rows })).json();
  assert.equal(log.pushes.length, 2, "Carol and unassigned rows notify nobody");
  const aliceCustomers = [0, 2, 3].map((i) => body.results[i].customerId);
  const toAlice = log.pushes.find((p) => p.token === token("Alice")).data;
  assert.deepEqual([toAlice.type, toAlice.title, toAlice.body], ["assigned", "New customers assigned", "3 new customers"]);
  assert.ok(aliceCustomers.includes(toAlice.customerId));
  assert.equal(toAlice.customerName, rows.find((_, i) => body.results[i].customerId === toAlice.customerId).name);
  const toBob = log.pushes.find((p) => p.token === token("Bob")).data;
  assert.deepEqual([toBob.type, toBob.title, toBob.body, toBob.customerId], ["assigned", "New customer assigned", "P1", body.results[1].customerId]);
  // Re-running creates nothing, so nobody is notified again.
  await f.bulk({ rows });
  assert.equal(log.pushes.length, 2);
});
