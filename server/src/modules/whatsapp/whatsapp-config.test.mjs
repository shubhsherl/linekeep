import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { createDatabase, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { createIdentityRepository } = await loadModule("./identity.ts");
const { ruleMatches, normalizeMatchText } = await loadModule("./whatsapp-config.ts");
const adminSecret = "synthetic-config-admin-secret-not-for-deployment";
const appSecret = "synthetic-app-secret";
const phoneNumberId = "1000000000000001";
const whatsapp = {
  WHATSAPP_TOKEN: "synthetic-token", WHATSAPP_PHONE_NUMBER_ID: phoneNumberId, WHATSAPP_WABA_ID: "1000000000000002",
  WHATSAPP_APP_SECRET: appSecret, WHATSAPP_VERIFY_TOKEN: "synthetic-verify",
};
const templates = [{ name: "welcome", language: "en", status: "APPROVED", category: "MARKETING", parameter_format: "POSITIONAL", components: [
  { type: "BODY", text: "Hi! I'm {{1}}, call me on {{2}} ({{3}}).", example: { body_text: [["A", "9", "b"]] } }] }];

async function fixture(t) {
  const DB = await createDatabase(t);
  const identity = createIdentityRepository(DB, "synthetic-config-token-secret-not-for-deployment");
  const asha = await identity.createEmployee({ name: "Asha", phoneNumber: "9876500001" });
  const env = { DB, TOKEN_HASH_SECRET: "synthetic-config-token-secret-not-for-deployment", LOCAL_ADMIN_SECRET: adminSecret, ENVIRONMENT: "development", ...whatsapp };
  const app = createApp();
  const request = (path, init = {}) => app.request(new URL(path, "http://127.0.0.1"), init, env);
  const admin = (method, path, body) => request(path, {
    method, headers: { Authorization: `Bearer ${adminSecret}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const customer = (await (await admin("POST", "/v1/admin/customers", { name: "Buyer", phone: "9123456789", employeeIds: [asha.id] })).json()).customer;
  const hook = (from, id, body, extra = {}) => {
    const raw = JSON.stringify({ entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId },
      messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body }, ...extra }] } }] }] });
    return request("/v1/webhooks/whatsapp", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=" + createHmac("sha256", appSecret).update(raw).digest("hex") }, body: raw });
  };
  const rule = async (body) => (await (await admin("POST", "/v1/admin/whatsapp/auto-replies", { matchType: "contains", cooldownMinutes: 60, ...body })).json()).rule;
  const thread = async (id = customer.id) => (await (await admin("GET", `/v1/admin/customers/${id}/messages`)).json()).items;
  return { DB, admin, request, customer, hook, rule, thread };
}

function stubGraph(t, handler = (n) => new Response(JSON.stringify({ messages: [{ id: `wamid.AUTO${n}` }] }), { status: 200 })) {
  const sends = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/message_templates")) {
      const wanted = new URL(String(url)).searchParams.get("name");
      return new Response(JSON.stringify({ data: templates.filter((x) => !wanted || x.name === wanted) }), { status: 200 });
    }
    sends.push(JSON.parse(init.body));
    return handler(sends.length);
  };
  t.after(() => { globalThis.fetch = original; });
  return sends;
}

test("matching compares normalized text by type", () => {
  const contains = { matchType: "contains", keywords: ["price list"] };
  assert.equal(normalizeMatchText("  PRICE\n  List "), "price list");
  assert.equal(ruleMatches(contains, "Please send  PRICE LIST now"), true);
  assert.equal(ruleMatches(contains, "price"), false);
  assert.equal(ruleMatches({ matchType: "exact", keywords: ["hi"] }, "Hi "), true);
  assert.equal(ruleMatches({ matchType: "exact", keywords: ["hi"] }, "hi there"), false);
  assert.equal(ruleMatches({ matchType: "starts_with", keywords: ["stop"] }, "STOP sending"), true);
  assert.equal(ruleMatches({ matchType: "starts_with", keywords: ["stop"] }, "please stop"), false);
  assert.equal(ruleMatches(contains, "   "), false);
});

test("rules and quick messages are admin-only, validated, ordered and limited", async (t) => {
  const f = await fixture(t);
  const anon = await f.request("/v1/admin/whatsapp/auto-replies");
  assert.ok([401, 302].includes(anon.status));
  const a = await f.rule({ name: "Prices", keywords: ["Price", " price  list "], reply: { type: "text", text: "Hello {{name}}" } });
  assert.deepEqual(a.keywords, ["price", "price list"]);
  assert.equal(a.triggerCount, 0);
  const b = await f.rule({ name: "Hi", matchType: "exact", keywords: ["hi"], reply: { type: "text", text: "Hey" } });
  for (const bad of [
    { name: "", keywords: ["x"], reply: { type: "text", text: "y" } },
    { name: "n", keywords: [], reply: { type: "text", text: "y" } },
    { name: "n", keywords: ["x"], reply: { type: "text", text: "" } },
    { name: "n", keywords: ["x"], reply: { type: "template", name: "Bad Name", language: "en", params: [] } },
    { name: "n", keywords: ["x"], reply: { type: "template", name: "ok", language: "en", params: [{ source: "custom" }] } },
    { name: "n", keywords: ["x"], reply: { type: "text", text: "y" }, cooldownMinutes: 0 },
    { name: "n", keywords: ["x"], reply: { type: "text", text: "y" }, extra: 1 },
  ]) assert.equal((await f.admin("POST", "/v1/admin/whatsapp/auto-replies", { matchType: "contains", ...bad })).status, 400, JSON.stringify(bad));

  const patched = await (await f.admin("PATCH", `/v1/admin/whatsapp/auto-replies/${a.id}`, { enabled: false, cooldownMinutes: 5 })).json();
  assert.deepEqual([patched.rule.enabled, patched.rule.cooldownMinutes, patched.rule.name], [false, 5, "Prices"]);
  assert.equal((await f.admin("PATCH", `/v1/admin/whatsapp/auto-replies/${a.id}`, {})).status, 400);
  assert.equal((await f.admin("PATCH", "/v1/admin/whatsapp/auto-replies/war_missing", { name: "x" })).status, 404);

  const reordered = await (await f.admin("POST", "/v1/admin/whatsapp/auto-replies/reorder", { ids: [b.id, a.id] })).json();
  assert.deepEqual(reordered.items.map((x) => x.id), [b.id, a.id]);
  assert.equal((await f.admin("POST", "/v1/admin/whatsapp/auto-replies/reorder", { ids: [b.id] })).status, 400);
  assert.equal((await f.admin("POST", "/v1/admin/whatsapp/auto-replies/reorder", { ids: [b.id, b.id] })).status, 400);

  await f.admin("DELETE", `/v1/admin/whatsapp/auto-replies/${a.id}`);
  assert.deepEqual((await (await f.admin("GET", "/v1/admin/whatsapp/auto-replies")).json()).items.map((x) => x.id), [b.id]);

  const createdQuick = await f.admin("POST", "/v1/admin/whatsapp/quick-messages", { title: "Zeta", text: "z" });
  assert.equal(createdQuick.status, 201);
  const q = (await createdQuick.json()).message;
  await f.admin("POST", "/v1/admin/whatsapp/quick-messages", { title: "alpha", text: "a" });
  assert.deepEqual((await (await f.admin("GET", "/v1/admin/whatsapp/quick-messages")).json()).items.map((x) => x.title), ["alpha", "Zeta"]);
  const edited = await (await f.admin("PATCH", `/v1/admin/whatsapp/quick-messages/${q.id}`, { text: "zz" })).json();
  assert.deepEqual([edited.message.title, edited.message.text], ["Zeta", "zz"]);
  assert.equal((await f.admin("POST", "/v1/admin/whatsapp/quick-messages", { title: "", text: "x" })).status, 400);
  await f.admin("DELETE", `/v1/admin/whatsapp/quick-messages/${q.id}`);
  assert.equal((await (await f.admin("GET", "/v1/admin/whatsapp/quick-messages")).json()).items.length, 1);

  for (let i = 0; i < 49; i++) await f.rule({ name: `r${i}`, keywords: ["k"], reply: { type: "text", text: "t" } });
  for (let i = 0; i < 99; i++) await f.admin("POST", "/v1/admin/whatsapp/quick-messages", { title: `q${i}`, text: "t" });
  assert.equal((await f.admin("POST", "/v1/admin/whatsapp/quick-messages", { title: "too many", text: "t" })).status, 409);
  const over = await f.admin("POST", "/v1/admin/whatsapp/auto-replies", { name: "one too many", matchType: "contains", keywords: ["k"], reply: { type: "text", text: "t" } });
  assert.equal(over.status, 409);
  assert.equal((await over.json()).error.code, "LIMIT_REACHED");
});

test("a matching customer message gets exactly one reply, however often Meta redelivers it", async (t) => {
  const f = await fixture(t);
  const sends = stubGraph(t);
  await f.rule({ name: "Prices", keywords: ["price"], reply: { type: "text", text: "Hi {{name}}, call {{handler_name}} on {{handler_phone}}. {{unknown}}" } });
  assert.equal((await f.hook("919123456789", "wamid.IN1", "What is the PRICE?")).status, 200);
  assert.equal((await f.hook("919123456789", "wamid.IN1", "What is the PRICE?")).status, 200);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text.body, "Hi Buyer, call Asha on +919876500001. {{unknown}}");
  assert.equal(sends[0].to, "919123456789");
  const items = await f.thread();
  assert.deepEqual(items.map((m) => [m.direction, m.status]), [["out", "sent"], ["in", "delivered"]]);
  const rules = (await (await f.admin("GET", "/v1/admin/whatsapp/auto-replies")).json()).items;
  assert.equal(rules[0].triggerCount, 1);
  const activity = (await (await f.admin("GET", "/v1/admin/whatsapp/auto-replies/activity")).json()).items;
  assert.deepEqual(activity.map((x) => [x.ruleName, x.customerName, x.status]), [["Prices", "Buyer", "sent"]]);
});

test("cooldown, disabled rules, rule order, exact matching and stale messages decide whether a reply is sent", async (t) => {
  const f = await fixture(t);
  const sends = stubGraph(t);
  await f.rule({ name: "Exact hi", matchType: "exact", keywords: ["hi"], reply: { type: "text", text: "exact" } });
  const disabled = await f.rule({ name: "Off", keywords: ["offer"], enabled: false, reply: { type: "text", text: "never" } });
  await f.rule({ name: "First", keywords: ["offer"], reply: { type: "text", text: "first" } });
  await f.rule({ name: "Second", keywords: ["offer"], reply: { type: "text", text: "second" } });
  assert.ok(disabled.id);

  await f.hook("919123456789", "wamid.A", "hi there"); // exact rule must not match
  assert.equal(sends.length, 0);
  await f.hook("919123456789", "wamid.B", "any OFFER today?");
  assert.deepEqual(sends.map((s) => s.text.body), ["first"]); // disabled skipped, first of the matching rules wins
  await f.hook("919123456789", "wamid.C", "offer again");
  assert.equal(sends.length, 1); // still cooling down for this customer
  await f.hook("919000000001", "wamid.D", "offer"); // a different customer is not cooling down
  assert.equal(sends.length, 2);

  const stale = JSON.stringify({ entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId },
    messages: [{ id: "wamid.OLD", from: "919000000002", timestamp: String(Math.floor(Date.now() / 1000) - 3600), type: "text", text: { body: "offer" } }] } }] }] });
  await f.request("/v1/webhooks/whatsapp", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=" + createHmac("sha256", appSecret).update(stale).digest("hex") }, body: stale });
  assert.equal(sends.length, 2); // an hour-old message is a redelivery, not a conversation
});

test("button taps trigger rules, template replies fill their variables from the chosen sources, and failures are logged", async (t) => {
  const f = await fixture(t);
  const sends = stubGraph(t);
  await f.rule({ name: "Interested", matchType: "exact", keywords: ["i'm interested"], reply: { type: "template", name: "welcome", language: "en",
    params: [{ source: "handler_name" }, { source: "handler_phone" }, { source: "custom", value: "Delhi" }] } });
  await f.hook("919123456789", "wamid.BTN", undefined, { type: "button", text: undefined, button: { payload: "p", text: "I'm Interested" } });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].type, "template");
  assert.deepEqual(sends[0].template.components[0].parameters.map((p) => p.text), ["Asha", "+919876500001", "Delhi"]);
  assert.equal((await f.thread())[0].body, "Hi! I'm Asha, call me on +919876500001 (Delhi).");

  const f2 = await fixture(t);
  stubGraph(t, () => new Response(JSON.stringify({ error: { code: 131047 } }), { status: 400 }));
  await f2.rule({ name: "Fails", keywords: ["help"], reply: { type: "text", text: "we help" } });
  assert.equal((await f2.hook("919123456789", "wamid.F", "help me")).status, 200);
  const activity = (await (await f2.admin("GET", "/v1/admin/whatsapp/auto-replies/activity")).json()).items;
  assert.deepEqual(activity.map((x) => x.status), ["failed"]);
  assert.equal((await f2.thread())[0].status, "failed");
});

test("employees' phones can read quick messages, anonymous callers cannot", async (t) => {
  const f = await fixture(t);
  await f.admin("POST", "/v1/admin/whatsapp/quick-messages", { title: "Greeting", text: "Hello {{name}}" });
  assert.equal((await f.request("/v1/device/whatsapp/quick-messages")).status, 401);
});
