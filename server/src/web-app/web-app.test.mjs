import assert from "node:assert/strict";
import test from "node:test";

import { loadModule } from "../data/test-support.mjs";

const { logicJavaScript } = await loadModule("../web-app/logic.ts");
const { webClientJavaScript } = await loadModule("../web-app/client.ts");
const { createWebAppRoutes, webAppContentSecurityPolicy } = await loadModule("../web-app/index.ts");

const names = [
  "normalizePhone", "validateNewCustomer", "createCustomerBody", "patchCustomerBody", "decideAfterLookup", "buildVCard",
  "vcardFileName", "initialsOf", "parseRoute", "formatRoute", "authInitial", "authReduce", "resendRemaining", "normalizeEmail",
  "validEmail", "cleanCode", "parseIdentifier", "authRequestBody", "authVerifyBody", "maskEmail", "maskPhone", "maskIdentifier", "createApiClient", "nextPollDelay", "createPoller", "POLL_BROWSING", "POLL_CONVERSATION",
  "fillQuickPlaceholders", "defaultVariableSource", "initialTemplateValues", "renderTemplateText", "templateProblem",
  "templateSendBody", "mediaSendBody", "textSendBody", "attachProblem", "conversationRows", "mergeMessages", "newClientMessageId",
  "OTHER_HANDLER_MESSAGE", "CSRF_HEADER",
];
const logic = new Function(`${logicJavaScript}\nreturn { ${names.join(", ")} };`)();

test("the assembled client script is valid JavaScript without template-literal hazards", () => {
  assert.doesNotThrow(() => new Function(webClientJavaScript));
  for (const source of [logicJavaScript, webClientJavaScript]) {
    assert.ok(!source.includes("innerHTML"));
    assert.ok(!/setAttribute\(\s*['"]style['"]/.test(source), "inline styles would violate the CSP");
    assert.ok(!/\beval\(|new Function\(/.test(source));
  }
});

test("employee bundle ships none of the admin-only features", () => {
  for (const forbidden of ["/v1/admin", "/v1/device", "auto-replies", "bulk", "archive", "/employees", "template-images", "DELETE", "'delete'"]) {
    assert.ok(!webClientJavaScript.includes(forbidden), `client must not mention ${forbidden}`);
  }
  assert.ok(!/localStorage\.setItem\([^)]*(csrf|token)/i.test(webClientJavaScript));
});

test("phone numbers are normalised like the server", () => {
  assert.equal(logic.normalizePhone("98000 00001").phone, "+919800000001");
  assert.equal(logic.normalizePhone("09800000001").phone, "+919800000001");
  assert.equal(logic.normalizePhone("+1 (415) 555-0100").phone, "+14155550100");
  assert.equal(logic.normalizePhone("123"), null);
  assert.equal(logic.normalizePhone("1234567890123456"), null);
  assert.equal(logic.normalizePhone("abc"), null);
});

test("add-customer form validation and bodies", () => {
  assert.match(logic.validateNewCustomer("", "9800000001", ""), /name/);
  assert.match(logic.validateNewCustomer("A", "12", ""), /phone/);
  assert.match(logic.validateNewCustomer("A", "9800000001", "x".repeat(4001)), /Notes/);
  assert.equal(logic.validateNewCustomer(" Asha ", "9800000001", ""), "");
  assert.deepEqual({ ...logic.createCustomerBody(" Asha ", "9800000001", " hi ") }, { name: "Asha", phone: "+919800000001", notes: "hi" });
  assert.deepEqual({ ...logic.createCustomerBody("Asha", "9800000001", "  ") }, { name: "Asha", phone: "+919800000001" });
});

test("patch body carries only changed name and notes and never the phone", () => {
  const original = { name: "Asha", phone: "+919800000001", notes: "n" };
  assert.equal(logic.patchCustomerBody(original, "Asha ", "n"), null);
  assert.deepEqual({ ...logic.patchCustomerBody(original, "Asha K", "n") }, { name: "Asha K" });
  assert.deepEqual({ ...logic.patchCustomerBody(original, "Asha", "") }, { notes: "" });
  assert.ok(!("phone" in logic.patchCustomerBody(original, "B", "m")));
});

test("lookup decisions never reveal other handlers' customers", () => {
  assert.deepEqual({ ...logic.decideAfterLookup({ exists: false }) }, { action: "create" });
  assert.deepEqual({ ...logic.decideAfterLookup({ exists: true, mine: true, customer: { id: "c1", name: "A" } }) }, { action: "open", customerId: "c1", name: "A" });
  assert.deepEqual({ ...logic.decideAfterLookup({ exists: true, mine: false }) }, { action: "other" });
  assert.match(logic.OTHER_HANDLER_MESSAGE, /another handler\. Ask your manager\.$/);
});

test("vCard has name and phone only, CRLF endings and escaping", () => {
  const card = logic.buildVCard("Asha; K, Synthetic", "+91 98000-00001");
  assert.equal(card, "BEGIN:VCARD\r\nVERSION:3.0\r\nN:Asha\\; K\\, Synthetic;;;;\r\nFN:Asha\\; K\\, Synthetic\r\nTEL;TYPE=CELL:+919800000001\r\nEND:VCARD\r\n");
  assert.equal(logic.vcardFileName("Asha K/../x"), "Asha-K.x.vcf");
  assert.equal(logic.vcardFileName("  "), "contact.vcf");
  assert.equal(logic.initialsOf("asha kumar rao"), "AR");
});

test("routes parse and format", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(logic.parseRoute("#whatsapp/cus_1"))), { view: "whatsapp", parts: ["cus_1"], query: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(logic.parseRoute("#analytics/calls?type=missed"))), { view: "analytics", parts: ["calls"], query: { type: "missed" } });
  assert.equal(logic.parseRoute("").view, "customers");
  assert.equal(logic.parseRoute("#admin/employees").view, "customers");
  assert.equal(logic.formatRoute({ view: "analytics", parts: ["calls"], query: { type: "missed", x: "" } }), "#analytics/calls?type=missed");
  assert.equal(logic.parseRoute("#customers/a%20b").parts[0], "a b");
});

test("sign-in state machine", () => {
  let state = logic.authInitial();
  state = logic.authReduce(state, { type: "config", enabled: false, methods: [] });
  assert.equal(state.screen, "disabled");
  state = logic.authReduce(logic.authInitial(), { type: "config", enabled: true, methods: ["email", "whatsapp", "sms"] });
  assert.equal(state.screen, "signin");
  assert.deepEqual([...state.methods], ["email", "whatsapp"]);
  state = logic.authReduce(state, { type: "method", method: "whatsapp" });
  assert.equal(state.method, "whatsapp");
  state = logic.authReduce(state, { type: "codeSent", identifier: "+919800000123", method: "whatsapp", at: 1000 });
  assert.equal(state.screen, "code");
  assert.equal(state.identifier, "+919800000123");
  // A config refresh while entering the code keeps the code screen.
  assert.equal(logic.authReduce(state, { type: "config", enabled: true, methods: ["email"] }).screen, "code");
  assert.equal(logic.authReduce(state, { type: "back" }).screen, "signin");
  assert.equal(logic.authReduce(state, { type: "session" }).screen, "app");
  const lost = logic.authReduce(logic.authReduce(state, { type: "session" }), { type: "sessionLost", notice: "bye" });
  assert.equal(lost.screen, "loading");
  assert.equal(lost.notice, "bye");
  assert.equal(logic.authReduce(state, { type: "config", enabled: true, methods: [] }).screen, "disabled");
});

test("only-whatsapp config starts on the WhatsApp method", () => {
  const state = logic.authReduce(logic.authInitial(), { type: "config", enabled: true, methods: ["whatsapp"] });
  assert.equal(state.screen, "signin");
  assert.equal(state.method, "whatsapp");
  assert.equal(logic.authReduce(state, { type: "method", method: "email" }).method, "whatsapp");
});

test("identifiers are parsed per method and sent in the matching body", () => {
  assert.deepEqual({ ...logic.parseIdentifier("email", " Asha@Example.TEST ") }, { value: "asha@example.test", error: "" });
  assert.match(logic.parseIdentifier("email", "asha@").error, /email/);
  assert.deepEqual({ ...logic.parseIdentifier("whatsapp", "98000 00123") }, { value: "+919800000123", error: "" });
  assert.deepEqual({ ...logic.parseIdentifier("whatsapp", "+1 (415) 555-0100") }, { value: "+14155550100", error: "" });
  assert.match(logic.parseIdentifier("whatsapp", "12").error, /phone/);
  assert.deepEqual({ ...logic.authRequestBody("email", "a@example.test") }, { method: "email", email: "a@example.test" });
  assert.deepEqual({ ...logic.authRequestBody("whatsapp", "+919800000123") }, { method: "whatsapp", phone: "+919800000123" });
  assert.deepEqual({ ...logic.authVerifyBody("whatsapp", "+919800000123", "123456") }, { method: "whatsapp", phone: "+919800000123", code: "123456" });
  assert.deepEqual({ ...logic.authVerifyBody("email", "a@example.test", "123456") }, { method: "email", email: "a@example.test", code: "123456" });
});

test("destinations are masked", () => {
  assert.equal(logic.maskEmail("asha@example.test"), "a***@example.test");
  assert.equal(logic.maskEmail("x@example.test"), "x***@example.test");
  assert.equal(logic.maskEmail("nonsense"), "***");
  assert.equal(logic.maskPhone("+919800000123"), "+91 ••••• ••123");
  assert.equal(logic.maskIdentifier("whatsapp", "+919800000123"), "+91 ••••• ••123");
  assert.equal(logic.maskIdentifier("email", "asha@example.test"), "a***@example.test");
  assert.ok(!logic.maskPhone("+14155550100").includes("5550"));
});

test("resend cooldown, email and code cleaning", () => {
  assert.equal(logic.resendRemaining(0, 5000), 0);
  assert.equal(logic.resendRemaining(1000, 11000), 20000);
  assert.equal(logic.resendRemaining(1000, 40000), 0);
  assert.equal(logic.normalizeEmail("  Asha@Example.TEST "), "asha@example.test");
  assert.ok(logic.validEmail("asha@example.test"));
  assert.ok(!logic.validEmail("asha@"));
  assert.ok(!logic.validEmail("a b@example.test"));
  assert.equal(logic.cleanCode("123 456"), "123456");
  assert.equal(logic.cleanCode(" 12-34-56 "), "123456");
  assert.equal(logic.cleanCode("12345"), "");
  assert.equal(logic.cleanCode("1234567"), "");
});

function fakeFetch(plan) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = plan.shift();
    if (next instanceof Error) throw next;
    return { ok: next.status < 400, status: next.status, headers: { get: (name) => next.headers?.[name] ?? null }, json: async () => { if (next.body === undefined) throw new Error("no json"); return next.body; } };
  };
  return { fetch, calls };
}

test("api client sends the CSRF header only on state-changing requests", async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: { a: 1 } }, { status: 200, body: {} }, { status: 202, body: {} }]);
  const client = logic.createApiClient({ fetch, getCsrf: () => "csrf-token", onUnauthorized: () => assert.fail("no 401") });
  await client.request("/customers");
  await client.request("/customers/c1", { method: "PATCH", body: { name: "A" } });
  await client.request("/auth/request", { method: "POST", body: { email: "a@example.test" }, public: true });
  assert.equal(calls[0].init.headers["X-Linekeep-CSRF"], undefined);
  assert.equal(calls[1].init.headers["X-Linekeep-CSRF"], "csrf-token");
  assert.equal(calls[1].init.headers["Content-Type"], "application/json");
  assert.equal(calls[1].init.body, '{"name":"A"}');
  assert.equal(calls[2].init.headers["X-Linekeep-CSRF"], undefined);
  assert.equal(calls[1].url, "/v1/web/customers/c1");
  assert.equal(calls[1].init.credentials, "same-origin");
});

test("api client reports a lost session once and surfaces error details", async () => {
  const lost = [];
  const { fetch } = fakeFetch([
    { status: 401, body: { requestId: "r1", error: { code: "unauthorized", message: "No session" } } },
    { status: 401, body: {} },
    { status: 429, headers: { "Retry-After": "120" }, body: { error: { code: "rate_limited", message: "Slow down" } } },
    { status: 409, body: { error: { code: "customer_exists", message: "exists", customerId: "c9" } } },
    { status: 401, body: { error: { code: "invalid_code", message: "bad" } } },
    { status: 200, body: { ok: true } },
    new Error("offline"),
    { status: 500 },
  ]);
  const client = logic.createApiClient({ fetch, getCsrf: () => "t", onUnauthorized: (error) => lost.push(error.code) });
  await assert.rejects(client.request("/profile"), (e) => e.status === 401 && e.code === "unauthorized" && e.requestId === "r1");
  await assert.rejects(client.request("/profile"), (e) => e.status === 401);
  assert.deepEqual(lost, ["unauthorized"], "reported once per burst");
  await assert.rejects(client.request("/auth/request", { method: "POST", body: {}, public: true }), (e) => e.status === 429 && e.retryAfter === 120);
  await assert.rejects(client.request("/customers", { method: "POST", body: {} }), (e) => e.customerId === "c9");
  await assert.rejects(client.request("/auth/verify", { method: "POST", body: {}, public: true }), (e) => e.code === "invalid_code");
  assert.deepEqual(lost, ["unauthorized"], "public 401 is not a lost session");
  await client.request("/profile");
  await assert.rejects(client.request("/profile"), (e) => e.status === 0 && e.code === "network");
  await assert.rejects(client.request("/profile"), (e) => e.code === "unreadable" || e.status === 500);
});

test("poll delays follow the Android policy", () => {
  const { nextPollDelay, POLL_BROWSING: browsing, POLL_CONVERSATION: conversation } = logic;
  assert.equal(nextPollDelay(browsing, 0, 0), 15000);
  assert.equal(nextPollDelay(browsing, 2, 0), 15000);
  assert.equal(nextPollDelay(browsing, 3, 0), 30000);
  assert.equal(nextPollDelay(browsing, 4, 0), 60000);
  assert.equal(nextPollDelay(browsing, 40, 0), 60000);
  assert.equal(nextPollDelay(conversation, 6, 0), 5000);
  assert.equal(nextPollDelay(conversation, 7, 0), 10000);
  assert.equal(nextPollDelay(conversation, 30, 0), 20000);
  assert.equal(nextPollDelay(conversation, 0, 1), 10000);
  assert.equal(nextPollDelay(conversation, 0, 9), 60000);
});

test("poller backs off, pauses while hidden and resumes on a poke", async () => {
  const timers = [];
  let hidden = false;
  let conversation = false;
  let outcome = false;
  const poller = logic.createPoller({
    schedule: (fn, ms) => { const timer = { fn, ms, cancelled: false }; timers.push(timer); return timer; },
    cancel: (timer) => { timer.cancelled = true; },
    hidden: () => hidden,
    policy: () => (conversation ? logic.POLL_CONVERSATION : logic.POLL_BROWSING),
    check: async () => { if (outcome instanceof Error) throw outcome; return outcome; },
  });
  const live = () => timers.filter((timer) => !timer.cancelled);
  const fire = async () => { const timer = live().at(-1); timer.cancelled = true; await timer.fn(); };
  poller.start();
  assert.equal(live().at(-1).ms, 15000);
  await fire();
  assert.equal(live().at(-1).ms, 15000);
  for (let index = 0; index < 4; index++) await fire();
  assert.equal(live().at(-1).ms, 60000);
  outcome = true;
  await fire();
  assert.equal(live().at(-1).ms, 15000, "a change resets the back-off");
  outcome = new Error("down");
  await fire();
  assert.equal(live().at(-1).ms, 30000);
  hidden = true;
  poller.visibility();
  assert.equal(live().length, 0, "nothing is scheduled while the tab is hidden");
  hidden = false;
  conversation = true;
  outcome = false;
  poller.visibility();
  assert.equal(live().at(-1).ms, 0, "coming back polls at once");
  await fire();
  assert.equal(live().at(-1).ms, 5000);
  poller.stop();
  assert.equal(live().length, 0);
});

test("quick reply placeholders", () => {
  const filled = logic.fillQuickPlaceholders("Hi {{name}}, {{ handler_name }} here. Call {{handler_phone}} {{name}}", { name: "Asha", handler_name: "Ravi", handler_phone: "" });
  assert.equal(filled.text, "Hi Asha, Ravi here. Call {{handler_phone}} Asha");
  assert.deepEqual([...filled.missing], ["handler_phone"]);
});

const template = { name: "welcome", language: "en_US", header: "", body: "Hello {{1}}, call {{2}} about {{3}}", footer: "", buttons: [], variables: [{ key: "1" }, { key: "2" }, { key: "3" }], sendable: true, headerFormat: "NONE", headerImageConfigured: false };

test("template variables default to handler details and render", () => {
  const values = logic.initialTemplateValues(template, { customerName: "Asha", handlerName: "Ravi", handlerPhone: "+919800000009" });
  assert.deepEqual([...values], ["Ravi", "+919800000009", ""]);
  assert.equal(logic.defaultVariableSource("2", 5), "handler_phone");
  assert.equal(logic.renderTemplateText(template, values), "Hello Ravi, call +919800000009 about {{3}}");
  assert.equal(logic.templateProblem(template, values, null), "Fill in every variable.");
  values[2] = "your order\nnow";
  assert.equal(logic.templateProblem(template, values, null), "");
  const body = logic.templateSendBody("id-1", template, values, "");
  assert.deepEqual(JSON.parse(JSON.stringify(body)), { clientMessageId: "id-1", template: { name: "welcome", language: "en_US", params: ["Ravi", "+919800000009", "your order now"] } });
  const media = { ...template, headerFormat: "IMAGE" };
  assert.equal(logic.templateProblem(media, values, null), "Choose a header file.");
  assert.equal(logic.templateProblem(media, values, { attachmentId: "wat_1" }), "");
  assert.equal(logic.templateProblem({ ...template, sendable: false, reason: "No." }, values, null), "No.");
  assert.equal(logic.templateSendBody("i", media, values, "wat_1").template.headerAttachmentId, "wat_1");
});

test("send bodies and attachment checks", () => {
  assert.deepEqual({ ...logic.textSendBody("i", "hi") }, { clientMessageId: "i", text: "hi" });
  assert.deepEqual({ ...logic.mediaSendBody("i", "wat_1", " cap ") }, { clientMessageId: "i", type: "media", attachmentId: "wat_1", caption: "cap" });
  assert.ok(!("caption" in logic.mediaSendBody("i", "wat_1", "  ")));
  const kinds = ["image", "video", "document"];
  assert.equal(logic.attachProblem({ type: "image/png", size: 1000 }, kinds), "");
  assert.match(logic.attachProblem({ type: "application/zip", size: 10 }, kinds), /cannot be sent/);
  assert.match(logic.attachProblem({ type: "image/jpeg", size: 0 }, kinds), /empty/);
  assert.match(logic.attachProblem({ type: "image/jpeg", size: 6 * 1024 * 1024 }, kinds), /5 MB/);
  assert.match(logic.attachProblem({ type: "application/pdf", size: 17 * 1024 * 1024 }, kinds), /16 MB/);
});

test("conversation rows add day separators and messages merge without duplicates", () => {
  const at = (day, hour, id) => ({ id, sentAt: new Date(2026, 9, day, hour, 0, 0).toISOString() });
  const newestFirst = [at(2, 10, "m3"), at(2, 9, "m2"), at(1, 23, "m1")];
  const rows = logic.conversationRows(newestFirst);
  assert.deepEqual(rows.map((row) => row.message.id), ["m1", "m2", "m3"]);
  assert.deepEqual(rows.map((row) => row.day !== null), [true, true, false]);
  const merged = logic.mergeMessages(newestFirst, [at(2, 11, "m4"), { ...at(2, 10, "m3"), status: "read" }]);
  assert.deepEqual(merged.map((message) => message.id), ["m4", "m3", "m2", "m1"]);
  assert.equal(merged[1].status, "read");
});

test("client message ids are uuids", () => {
  assert.match(logic.newClientMessageId({ randomUUID: () => "00000000-0000-4000-8000-000000000000" }), /^[0-9a-f-]{36}$/);
  const id = logic.newClientMessageId({ getRandomValues: (bytes) => { bytes.fill(255); } });
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("app routes serve the shell with a strict CSP and no caching", async () => {
  const app = createWebAppRoutes();
  for (const path of ["/", "/customers", "/whatsapp/cus_1/deep"]) {
    const response = await app.request(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("Content-Type"), /text\/html/);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
    assert.equal(response.headers.get("Content-Security-Policy"), webAppContentSecurityPolicy);
    const html = await response.text();
    assert.match(html, /\/app\/client\.js/);
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), "no inline scripts");
    assert.ok(!/\sstyle=/.test(html), "no inline styles");
    assert.ok(!/https?:\/\//.test(html.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "")), "no external assets");
  }
  assert.doesNotMatch(webAppContentSecurityPolicy, /unsafe|https:|\*/);
  const script = await app.request("/client.js");
  assert.match(script.headers.get("Content-Type"), /javascript/);
  assert.equal(script.headers.get("Cache-Control"), "no-store");
  const css = await app.request("/styles.css");
  assert.match(css.headers.get("Content-Type"), /text\/css/);
  assert.equal((await app.request("/", { method: "POST" })).status, 404);
});
