import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase, enableFeatures, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { createIdentityRepository } = await loadModule("./identity.ts");
const { createSettingsStore } = await loadModule("../settings/store.ts");
const adminSecret = "synthetic-template-cache-admin-secret-not-for-deployment";
const tokenSecret = "synthetic-template-cache-token-secret-not-for-deployment";
const whatsapp = {
  WHATSAPP_TOKEN: "synthetic-token", WHATSAPP_PHONE_NUMBER_ID: "1000000000000001", WHATSAPP_WABA_ID: "1000000000000002",
};
const DAY = 24 * 3600e3;

const template = (name, body = "Hello") => ({
  name, language: "en_US", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: body }],
});

/**
 * A counting fake Graph API. `state.templates` is what Meta currently holds, `state.pageSize` splits it into pages,
 * `state.fail` makes template listing fail, and `state.sendReply` decides each message send.
 */
function stubGraph(t) {
  const state = { templates: [template("hello_world"), template("order_update")], pageSize: 100, fail: false, sendReply: null, listCalls: [], sends: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/message_templates")) {
      state.listCalls.push({ url: String(url), search: parsed.searchParams, path: parsed.pathname });
      if (state.fail) return new Response("{}", { status: 500 });
      const offset = Number(parsed.searchParams.get("after") ?? 0);
      const page = state.templates.slice(offset, offset + state.pageSize);
      const more = offset + state.pageSize < state.templates.length;
      return new Response(JSON.stringify({
        data: page,
        ...(more ? { paging: { cursors: { after: String(offset + state.pageSize) }, next: `${parsed.origin}${parsed.pathname}?access_token=SECRET&after=${offset + state.pageSize}` } } : {}),
      }), { status: 200 });
    }
    state.sends.push(JSON.parse(init.body));
    return state.sendReply ? state.sendReply(state.sends.length) : new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${state.sends.length}` }] }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; });
  return state;
}

/** Moves the clock the cache sees (Date.now) forward. */
function clock(t) {
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;
  t.after(() => { Date.now = real; });
  return (ms) => { offset += ms; };
}

async function fixture(t, extraEnv = whatsapp) {
  const DB = await createDatabase(t);
  await enableFeatures(DB);
  const identity = createIdentityRepository(DB, tokenSecret);
  const alice = await identity.createEmployee({ name: "Alice" });
  const device = await identity.redeemInvitation((await identity.createInvitation(alice.id, "2099-01-01T00:00:00Z")).invitationCode, { model: "Synthetic" });
  const env = { DB, TOKEN_HASH_SECRET: tokenSecret, LOCAL_ADMIN_SECRET: adminSecret, ENVIRONMENT: "development", ...extraEnv };
  const app = createApp();
  const requestWith = (e) => (path, init = {}) => app.request(new URL(path, "http://127.0.0.1"), init, e);
  const request = requestWith(env);
  const admin = (method, path, body, call = request) => call(path, {
    method, headers: { Authorization: `Bearer ${adminSecret}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const customer = (await (await admin("POST", "/v1/admin/customers", { name: "Buyer", phone: "9876543210", employeeIds: [alice.id] })).json()).customer;
  const send = (name, params = []) => admin("POST", `/v1/admin/customers/${customer.id}/messages`,
    { clientMessageId: crypto.randomUUID(), template: { name, language: "en_US", params } });
  const list = async (call = request) => (await admin("GET", "/v1/admin/whatsapp/templates", undefined, call));
  const refresh = () => admin("POST", "/v1/admin/whatsapp/templates/refresh");
  return { DB, env, device, request, requestWith, admin, customer, send, list, refresh };
}

test("lists and sends within the TTL make no Meta call after the first fetch", async (t) => {
  const graph = stubGraph(t);
  const f = await fixture(t);
  const first = await (await f.list()).json();
  assert.deepEqual(first.items.map((x) => x.name), ["hello_world", "order_update"]);
  assert.equal(graph.listCalls.length, 1);
  assert.equal(graph.listCalls[0].search.get("name"), null, "the whole list is fetched, never one name");
  assert.deepEqual(Object.keys(first.cache), ["fetchedAt", "expiresAt"]);
  assert.equal(Date.parse(first.cache.expiresAt) - Date.parse(first.cache.fetchedAt), 7 * DAY);

  const second = await (await f.list()).json();
  assert.deepEqual(second.cache, first.cache);
  assert.equal((await f.send("hello_world")).status, 201);
  assert.equal((await f.send("hello_world")).status, 201);
  const device = await f.request("/v1/device/whatsapp/templates", { headers: { Authorization: `Bearer ${f.device.deviceToken}` } });
  assert.equal(device.status, 200);
  assert.deepEqual((await device.json()).cache, first.cache);
  assert.equal(graph.listCalls.length, 1);
  assert.equal(graph.sends.length, 2);
  // The cache is a plain row in app_settings, a JSON copy keyed by account and Graph version.
  const row = JSON.parse((await f.DB.prepare("SELECT value, encrypted FROM app_settings WHERE key = 'cache.whatsappTemplates'").first()).value);
  assert.deepEqual([row.wabaId, row.graphVersion, row.templates.length], ["1000000000000002", "v23.0", 2]);
});

test("concurrent first requests share one Meta fetch", async (t) => {
  const graph = stubGraph(t);
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.list()));
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(graph.listCalls.length, 1);
});

test("a copy older than seven days is fetched again", async (t) => {
  const graph = stubGraph(t);
  const advance = clock(t);
  const f = await fixture(t);
  await f.list();
  advance(7 * DAY - 120_000);
  await f.list();
  assert.equal(graph.listCalls.length, 1);
  graph.templates = [template("hello_world"), template("brand_new")];
  advance(240_000);
  const after = await (await f.list()).json();
  assert.equal(graph.listCalls.length, 2);
  assert.deepEqual(after.items.map((x) => x.name), ["brand_new", "hello_world"]);
});

test("when Meta fails, a stale copy is served; with no copy the error shows", async (t) => {
  const graph = stubGraph(t);
  const advance = clock(t);
  const f = await fixture(t);
  graph.fail = true;
  assert.equal((await f.list()).status, 502);
  graph.fail = false;
  await f.list();
  advance(8 * DAY);
  graph.fail = true;
  const stale = await f.list();
  assert.equal(stale.status, 200);
  assert.deepEqual((await stale.json()).items.map((x) => x.name), ["hello_world", "order_update"]);
  assert.equal((await f.send("hello_world")).status, 201, "sends keep working from the stale copy");
  const callsNow = graph.listCalls.length;
  await f.list();
  assert.equal(graph.listCalls.length, callsNow, "a failed refresh is not retried on every request");
  advance(2 * 60_000);
  graph.fail = false;
  graph.templates = [template("only_one")];
  assert.deepEqual((await (await f.list()).json()).items.map((x) => x.name), ["only_one"]);
  const cache = await (await f.admin("GET", "/v1/admin/whatsapp/templates/cache")).json();
  assert.deepEqual([cache.count, cache.stale], [1, false]);
});

test("an unknown template triggers one refresh, then none for five minutes", async (t) => {
  const graph = stubGraph(t);
  const advance = clock(t);
  const f = await fixture(t);
  await f.list();
  assert.equal(graph.listCalls.length, 1);
  // Approved in Meta after the cache was filled: found by the on-demand refresh.
  graph.templates.push(template("fresh_offer"));
  advance(6 * 60_000);
  assert.equal((await f.send("fresh_offer")).status, 201);
  assert.equal(graph.listCalls.length, 2);
  // Genuinely unknown: one refresh, then the answer is given from the cache.
  advance(6 * 60_000);
  assert.equal((await f.send("missing_one")).status, 404);
  assert.equal(graph.listCalls.length, 3);
  assert.equal((await f.send("missing_one")).status, 404);
  assert.equal((await f.send("missing_two")).status, 404);
  assert.equal(graph.listCalls.length, 3);
  advance(5 * 60_000 + 1000);
  assert.equal((await f.send("missing_one")).status, 404);
  assert.equal(graph.listCalls.length, 4);
  assert.equal(graph.sends.length, 1);
});

test("the refresh endpoint forces a fetch, is limited to one per ten seconds, and needs WhatsApp and an admin", async (t) => {
  const graph = stubGraph(t);
  const advance = clock(t);
  const f = await fixture(t);
  assert.equal((await f.request("/v1/admin/whatsapp/templates/refresh", { method: "POST" })).status, 401);
  const empty = await (await f.admin("GET", "/v1/admin/whatsapp/templates/cache")).json();
  assert.deepEqual([empty.count, empty.fetchedAt, empty.expiresAt, empty.stale], [0, null, null, false]);
  assert.equal(graph.listCalls.length, 0, "reading the cache state never calls Meta");

  const first = await f.refresh();
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.count, 2);
  assert.ok(Number.isFinite(Date.parse(body.fetchedAt)));
  const tooSoon = await f.refresh();
  assert.equal(tooSoon.status, 429);
  assert.equal((await tooSoon.json()).error.code, "rate_limited");
  assert.equal(graph.listCalls.length, 1);

  advance(11_000);
  graph.templates.push(template("third"));
  const again = await (await f.refresh()).json();
  assert.equal(again.count, 3);
  assert.equal(graph.listCalls.length, 2);
  const state = await (await f.admin("GET", "/v1/admin/whatsapp/templates/cache")).json();
  assert.deepEqual([state.count, state.fetchedAt, state.stale], [3, again.fetchedAt, false]);

  advance(11_000);
  graph.fail = true;
  const failed = await f.refresh();
  assert.equal(failed.status, 502);
  assert.equal((await f.admin("GET", "/v1/admin/whatsapp/templates/cache").then((r) => r.json())).count, 3, "a failed refresh keeps the copy");

  const off = await fixture(t, { ...whatsapp, WHATSAPP_WABA_ID: undefined });
  assert.equal((await off.refresh()).status, 503);
  // Employees have no refresh endpoint.
  const device = await f.request("/v1/device/whatsapp/templates/refresh", { method: "POST", headers: { Authorization: `Bearer ${f.device.deviceToken}` } });
  assert.ok([404, 405].includes(device.status));
});

test("more than one page of templates is followed by cursor, without the access token from the next link", async (t) => {
  const graph = stubGraph(t);
  graph.pageSize = 2;
  graph.templates = ["t_a", "t_b", "t_c", "t_d", "t_e"].map((name) => template(name));
  const f = await fixture(t);
  const items = (await (await f.list()).json()).items;
  assert.deepEqual(items.map((x) => x.name), ["t_a", "t_b", "t_c", "t_d", "t_e"]);
  assert.equal(graph.listCalls.length, 3);
  assert.deepEqual(graph.listCalls.map((call) => call.search.get("after")), [null, "2", "4"]);
  assert.ok(graph.listCalls.every((call) => !call.search.has("access_token") && call.search.get("limit") === "100"));
  assert.equal((await f.send("t_e")).status, 201);
  assert.equal(graph.listCalls.length, 3);
});

test("a send that Meta rejects because the template is gone, paused or changed drops the cache", async (t) => {
  const graph = stubGraph(t);
  const reject = (code) => { graph.sendReply = () => new Response(JSON.stringify({ error: { code, message: "provider detail" } }), { status: 400 }); };

  // Errors unrelated to the template leave the cache alone.
  const calm = await fixture(t);
  await calm.list();
  reject(131026);
  assert.equal((await calm.send("hello_world")).status, 502);
  graph.sendReply = () => new Response("{}", { status: 500 });
  assert.equal((await calm.send("hello_world")).status, 502);
  await calm.list();
  assert.equal(graph.listCalls.length, 1);
  assert.equal((await calm.admin("GET", "/v1/admin/whatsapp/templates/cache").then((r) => r.json())).stale, false);

  for (const code of [132000, 132001, 132012, 132015, 132016]) {
    graph.listCalls.length = 0;
    graph.templates = [template("hello_world", "Hi {{1}}"), template("order_update")];
    const f = await fixture(t);
    await f.list();
    graph.templates = [template("order_update")];
    reject(code);
    const failed = await f.send("hello_world", ["x"]);
    assert.equal(failed.status, 502, String(code));
    assert.doesNotMatch(await failed.text(), /provider detail/);
    const state = await (await f.admin("GET", "/v1/admin/whatsapp/templates/cache")).json();
    assert.equal(state.stale, true, `${code}: the copy is known to be out of date`);
    assert.equal(graph.listCalls.length, 1, "invalidating costs no Meta call by itself");
    const shown = await (await f.list()).json();
    assert.equal(graph.listCalls.length, 2, `${code}: the next list asks Meta again`);
    assert.deepEqual(shown.items.map((x) => x.name), ["order_update"]);
    assert.equal((await f.admin("GET", "/v1/admin/whatsapp/templates/cache").then((r) => r.json())).stale, false);
  }
});

test("changing the WhatsApp account or Graph version misses the cache", async (t) => {
  const graph = stubGraph(t);
  const f = await fixture(t);
  await f.list();
  assert.equal(graph.listCalls.length, 1);
  const other = f.requestWith({ ...f.env, WHATSAPP_WABA_ID: "1000000000000099" });
  await f.list(other);
  assert.equal(graph.listCalls.length, 2);
  assert.match(graph.listCalls[1].path, /\/1000000000000099\//);
  const newer = f.requestWith({ ...f.env, WHATSAPP_WABA_ID: "1000000000000099", WHATSAPP_GRAPH_VERSION: "v24.0" });
  await f.list(newer);
  assert.equal(graph.listCalls.length, 3);
  assert.match(graph.listCalls[2].path, /\/v24\.0\//);
  // The state endpoint only reports a copy that matches the current configuration.
  const state = await (await f.admin("GET", "/v1/admin/whatsapp/templates/cache", undefined, newer)).json();
  assert.equal(state.count, 1 * 2);
  const back = await (await f.admin("GET", "/v1/admin/whatsapp/templates/cache")).json();
  assert.deepEqual([back.count, back.fetchedAt], [0, null]);
});

test("the cache row is not a setting: it is neither listed nor writable through the settings API", async (t) => {
  stubGraph(t);
  const f = await fixture(t);
  await f.list();
  assert.ok(await f.DB.prepare("SELECT 1 AS x FROM app_settings WHERE key = 'cache.whatsappTemplates'").first());
  const settings = await f.admin("GET", "/v1/admin/settings");
  const text = await settings.text();
  assert.equal(settings.status, 200);
  assert.doesNotMatch(text, /cache|hello_world|order_update|fetchedAt|attemptedAt/);
  for (const body of [{ whatsapp: { "cache.whatsappTemplates": "{}" } }, { "cache.whatsappTemplates": "{}" }, { cache: { whatsappTemplates: "{}" } }]) {
    for (const section of ["whatsapp", "features", "cache"]) {
      const response = await f.admin("PUT", `/v1/admin/settings/${section}`, body);
      assert.ok(response.status >= 400, `${section} ${JSON.stringify(body)}`);
    }
  }
  // The settings snapshot every request loads never carries the (large) cache row.
  const loaded = await createSettingsStore(f.DB, tokenSecret).readAll();
  assert.ok(![...loaded.values.keys()].some((key) => key.startsWith("cache.")));
  const stored = JSON.parse((await f.DB.prepare("SELECT value FROM app_settings WHERE key = 'cache.whatsappTemplates'").first()).value);
  assert.equal(stored.templates.length, 2);
  // A save through the real settings route does not disturb the cache either.
  assert.equal((await f.admin("PUT", "/v1/admin/settings/whatsapp", { phoneNumberId: "1000000000000001" })).status, 200);
  assert.ok(await f.DB.prepare("SELECT 1 AS x FROM app_settings WHERE key = 'cache.whatsappTemplates'").first());
});
