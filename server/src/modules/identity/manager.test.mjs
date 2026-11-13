import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { Miniflare } from "miniflare";

import { createDatabase, enableFeatures, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { createIdentityRepository } = await loadModule("./identity.ts");
const adminSecret = "synthetic-manager-admin-secret-not-for-deployment";
const tokenSecret = "synthetic-manager-token-secret-not-for-deployment";
const whatsapp = {
  WHATSAPP_TOKEN: "synthetic-token", WHATSAPP_PHONE_NUMBER_ID: "1000000000000001", WHATSAPP_WABA_ID: "1000000000000002",
  WHATSAPP_APP_SECRET: "synthetic-app-secret", WHATSAPP_VERIFY_TOKEN: "synthetic-verify",
};
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const fcm = JSON.stringify({
  client_email: "push@linekeep-test.iam.gserviceaccount.com", project_id: "linekeep-test",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const callsDay = "2026-10-12T04:00:00.000Z";
const analyticsQuery = "from=2026-10-12&to=2026-10-18";

/** A fake Graph API and FCM: records WhatsApp sends and pushes. */
function stubNetwork(t) {
  const sends = [], pushes = [], mails = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname === "oauth2.googleapis.com") return new Response(JSON.stringify({ access_token: "synthetic-access", expires_in: 3600 }), { status: 200 });
    if (u.hostname === "api.mailgun.net") {
      mails.push(init.body.get("text"));
      return new Response("{}", { status: 200 });
    }
    if (u.hostname === "fcm.googleapis.com") {
      const message = JSON.parse(init.body).message;
      pushes.push({ token: message.token, data: message.data });
      return new Response("{}", { status: 200 });
    }
    if (u.pathname.endsWith("/message_templates")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (u.pathname.endsWith("/media")) return new Response(JSON.stringify({ id: "7000001" }), { status: 200 });
    sends.push({ body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${sends.length}` }] }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; });
  return { sends, pushes, mails };
}

/**
 * Two teams, an unmanaged outsider and shared customers:
 *   manager A (MA): reports A1, A2     manager B (MB): report B1     outsider O (no manager)
 */
async function fixture(t) {
  const network = stubNetwork(t);
  const DB = await createDatabase(t);
  await enableFeatures(DB);
  await DB.prepare("UPDATE whatsapp_settings SET value = '2026-01-01T00:00:00.000Z' WHERE key = 'unread_since'").run();
  const runtime = new Miniflare({
    workers: [{ config: {
      name: "manager-tests", compatibilityDate: "2026-09-24",
      manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default { fetch() { return new Response(null, { status: 404 }); } }" } } },
      env: { RECORDINGS: { type: "r2", name: "manager-test-bucket" } },
    } }],
  });
  t.after(() => runtime.dispose());
  const RECORDINGS = await runtime.getR2Bucket("RECORDINGS");
  const env = { DB, RECORDINGS, TOKEN_HASH_SECRET: tokenSecret, LOCAL_ADMIN_SECRET: adminSecret, ENVIRONMENT: "development", FCM_SERVICE_ACCOUNT: fcm, ...whatsapp,
    MAILGUN_API_KEY: "synthetic-mailgun-key-0001", MAILGUN_DOMAIN: "mg.example.test", MAILGUN_FROM_EMAIL: "login@mg.example.test" };
  const app = createApp();
  const identity = createIdentityRepository(DB, tokenSecret);
  const request = (path, init = {}) => app.request(new URL(path, "http://127.0.0.1"), init, env);
  const admin = (method, path, body) => request(path, {
    method, headers: { Authorization: `Bearer ${adminSecret}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const people = {};
  const hire = async (key, name, extra = {}) => {
    const response = await admin("POST", "/v1/admin/employees", { name, ...extra });
    assert.equal(response.status, 201, `${name}: ${await response.clone().text()}`);
    const employee = (await response.json()).employee;
    const enrolled = await identity.redeemInvitation(
      (await identity.createInvitation(employee.id, "2099-01-01T00:00:00Z")).invitationCode, { model: `Synthetic ${key}` });
    people[key] = { employee, id: employee.id, token: enrolled.deviceToken, deviceId: enrolled.device.id };
    return people[key];
  };
  await hire("MA", "Manager A", { role: "manager" });
  await hire("A1", "Alice A1", { managerId: people.MA.id });
  await hire("A2", "Anna A2", { managerId: people.MA.id });
  await hire("MB", "Manager B", { role: "manager" });
  await hire("B1", "Bella B1", { managerId: people.MB.id });
  await hire("O", "Olive Outsider");

  const as = (key, method, path, body) => request(path, {
    method,
    headers: { Authorization: `Bearer ${people[key].token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const get = (key, path) => as(key, "GET", path);
  const json = async (response) => response.json();

  const customers = {};
  const customer = async (key, name, phone, owners) => {
    const response = await admin("POST", "/v1/admin/customers", { name, phone, employeeIds: owners.map((owner) => people[owner].id) });
    assert.equal(response.status, 201);
    customers[key] = (await response.json()).customer;
    await DB.prepare(
      `INSERT INTO whatsapp_messages (id, customer_id, direction, message_type, body, status, sent_at, source, created_at)
       VALUES (?, ?, 'in', 'text', ?, 'delivered', '2026-10-01T10:00:00.000Z', 'import', '2026-10-01T10:00:00.000Z')`,
    ).bind(`wam_in_${key}`, customers[key].id, `hello from ${name}`).run();
    return customers[key];
  };
  await customer("cA1", "Cust A1", "9800000001", ["A1"]);
  await customer("cA2", "Cust A2", "9800000002", ["A2"]);
  await customer("cMA", "Cust MA", "9800000003", ["MA"]);
  await customer("cShared", "Cust Shared", "9800000004", ["A1", "O"]);
  await customer("cB1", "Cust B1", "9800000005", ["B1"]);
  await customer("cO", "Cust O", "9800000006", ["O"]);
  await customer("cAB", "Cust AB", "9800000007", ["A1", "B1"]);

  // One recorded call per employee, two for A1.
  let sequence = 0;
  const callLogs = {};
  const log = async (key, remote, withAudio = false) => {
    sequence += 1;
    const id = `log_${sequence}`;
    await DB.prepare(
      `INSERT INTO call_logs (id, device_id, employee_id, fingerprint, started_at, duration_seconds, call_type, remote_number, created_at)
       VALUES (?, ?, ?, ?, ?, 90, 'outgoing', ?, ?)`,
    ).bind(id, people[key].deviceId, people[key].id, sequence.toString(16).padStart(64, "0"), callsDay, remote, callsDay).run();
    if (withAudio) {
      const objectKey = `recordings/synthetic-${sequence}.m4a`;
      await RECORDINGS.put(objectKey, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { httpMetadata: { contentType: "audio/mp4" } });
      await DB.prepare(
        `INSERT INTO calls (id, employee_id, device_id, fingerprint, display_name, match_status, object_key,
           content_type, expected_bytes, upload_status, created_at, call_log_id)
         VALUES (?, ?, ?, ?, 'rec.m4a', 'call_log', ?, 'audio/mp4', 8, 'complete', ?, ?)`,
      ).bind(`rec_${sequence}`, people[key].id, people[key].deviceId, `rec-fp-${sequence}`, objectKey, callsDay, id).run();
      // The link is set in a second step (an insert trigger would otherwise reset it).
      await DB.prepare("UPDATE calls SET call_log_id = ? WHERE id = ?").bind(id, `rec_${sequence}`).run();
    }
    callLogs[`${key}${Object.keys(callLogs).filter((name) => name.startsWith(key)).length + 1}`] = id;
    return id;
  };
  await log("MA", "+919800000003");
  await log("A1", "+919800000001", true);
  await log("A1", "+919800000004");
  await log("A2", "+919800000002");
  await log("MB", "+919800000009");
  await log("B1", "+919800000005", true);
  await log("O", "+919800000006", true);

  return { DB, RECORDINGS, env, request, admin, as, get, json, people, customers, callLogs, identity, ...network };
}

const ids = (items) => items.map((item) => item.id).sort();
const expectIds = (f, keys) => keys.map((key) => f.customers[key].id).sort();

test("customers: every viewer sees exactly the customers a handler of their scope handles", async (t) => {
  const f = await fixture(t);
  const expected = {
    A1: ["cA1", "cShared", "cAB"], A2: ["cA2"], O: ["cShared", "cO"], B1: ["cB1", "cAB"],
    MA: ["cA1", "cA2", "cMA", "cShared", "cAB"], MB: ["cB1", "cAB"],
  };
  for (const [who, keys] of Object.entries(expected)) {
    const body = await f.json(await f.get(who, "/v1/device/customers"));
    assert.deepEqual(ids(body.items), expectIds(f, keys), who);
    // Detail, messages and the chat list obey the same scope; anything else is a 404.
    for (const key of Object.keys(f.customers)) {
      const visible = keys.includes(key);
      assert.equal((await f.get(who, `/v1/device/customers/${f.customers[key].id}`)).status, visible ? 200 : 404, `${who} detail ${key}`);
      assert.equal((await f.get(who, `/v1/device/customers/${f.customers[key].id}/messages`)).status, visible ? 200 : 404, `${who} messages ${key}`);
    }
    const chats = await f.json(await f.get(who, "/v1/device/whatsapp/chats"));
    assert.deepEqual(chats.items.map((chat) => chat.customer.id).sort(), expectIds(f, keys), `${who} chats`);
  }
});

test("customers: only managers get the scope label and the employeeId filter", async (t) => {
  const f = await fixture(t);
  const mine = await f.json(await f.get("MA", "/v1/device/customers"));
  const label = Object.fromEntries(mine.items.map((item) => [item.name, item.scope]));
  assert.deepEqual(label, { "Cust A1": "team", "Cust A2": "team", "Cust MA": "own", "Cust Shared": "team", "Cust AB": "team" });
  assert.ok(mine.items.every((item) => Array.isArray(item.employees) && item.employees.length > 0));
  assert.ok((await f.json(await f.get("A1", "/v1/device/customers"))).items.every((item) => !("scope" in item)));

  const filtered = async (value) => ids((await f.json(await f.get("MA", `/v1/device/customers?employeeId=${value}`))).items);
  assert.deepEqual(await filtered("me"), expectIds(f, ["cMA"]));
  assert.deepEqual(await filtered("team"), expectIds(f, ["cA1", "cA2", "cShared", "cAB"]));
  assert.deepEqual(await filtered(f.people.A2.id), expectIds(f, ["cA2"]));
  assert.deepEqual(await filtered(f.people.MA.id), expectIds(f, ["cMA"]));
  for (const outside of [f.people.B1.id, f.people.O.id, f.people.MB.id, "emp_unknown"]) {
    const refused = await f.get("MA", `/v1/device/customers?employeeId=${outside}`);
    assert.equal(refused.status, 400);
    assert.equal((await f.json(refused)).error.code, "employee_out_of_scope");
  }
  assert.equal((await f.get("MA", `/v1/device/whatsapp/chats?employeeId=${f.people.B1.id}`)).status, 400);
  assert.deepEqual((await f.json(await f.get("MA", "/v1/device/whatsapp/chats?employeeId=me"))).items.map((chat) => chat.customer.id), [f.customers.cMA.id]);
  // The narrowed detail is a 404 when the customer is outside the narrowing.
  assert.equal((await f.get("MA", `/v1/device/customers/${f.customers.cA1.id}?employeeId=me`)).status, 404);

  for (const who of ["A1", "O", "B1"]) {
    for (const path of ["/v1/device/customers", "/v1/device/whatsapp/chats", "/v1/device/call-history", "/v1/device/whatsapp/unread"]) {
      const refused = await f.get(who, `${path}?employeeId=me`);
      assert.equal(refused.status, 400, `${who} ${path}`);
      assert.equal((await f.json(refused)).error.code, "not_a_manager");
    }
  }
});

test("chats and unread: managers see the team's chats, with their own read state", async (t) => {
  const f = await fixture(t);
  const chatsOf = async (who) => (await f.json(await f.get(who, "/v1/device/whatsapp/chats"))).items;
  const unreadOf = async (who) => (await f.json(await f.get(who, "/v1/device/whatsapp/unread")));
  const before = await unreadOf("MA");
  assert.deepEqual([before.chats, before.messages], [5, 5]);
  assert.equal((await unreadOf("A1")).chats, 3);
  assert.equal((await unreadOf("O")).chats, 2);
  assert.equal((await unreadOf("MB")).chats, 2);
  const chat = (await chatsOf("MA")).find((item) => item.customer.id === f.customers.cA1.id);
  assert.equal(chat.unreadCount, 1);
  assert.equal(chat.scope, "team");

  // The manager reading a team chat moves only the manager's marker.
  assert.equal((await as(f, "MA", "POST", `/v1/device/whatsapp/chats/${f.customers.cA1.id}/read`)).status, 200);
  assert.equal((await unreadOf("MA")).chats, 4);
  assert.equal((await unreadOf("A1")).chats, 3);
  assert.equal((await chatsOf("A1")).find((item) => item.customer.id === f.customers.cA1.id).unreadCount, 1);
  // Out-of-scope chats cannot be marked.
  for (const who of ["MB", "O", "A2"]) {
    assert.equal((await as(f, who, "POST", `/v1/device/whatsapp/chats/${f.customers.cA1.id}/read`)).status, 404, who);
  }
  // The feed version is shared and carries no customer data.
  assert.equal((await f.get("MA", "/v1/device/whatsapp/version")).status, 200);
});

function as(f, who, method, path, body) {
  return f.as(who, method, path, body);
}

test("messages and sending: managers write to team customers as themselves; nobody else can", async (t) => {
  const f = await fixture(t);
  const customerId = f.customers.cA1.id;
  await f.DB.prepare(
    `INSERT INTO whatsapp_messages (id, customer_id, direction, message_type, body, status, sent_at, source, created_at)
     VALUES ('wam_in_fresh', ?, 'in', 'text', 'fresh', 'delivered', ?, 'import', ?)`,
  ).bind(customerId, new Date().toISOString(), new Date().toISOString()).run();

  const send = (who, text = "hello", id = crypto.randomUUID()) => as(f, who, "POST", `/v1/device/customers/${customerId}/messages`, { clientMessageId: id, text });
  for (const who of ["MB", "O", "A2", "B1"]) assert.equal((await send(who)).status, 404, who);
  assert.equal(f.sends.length, 0);
  const sent = await send("MA", "from the manager");
  assert.equal(sent.status, 201);
  const message = (await f.json(sent)).message;
  assert.equal(message.sentBy.id, f.people.MA.id);
  assert.equal(f.sends.length, 1);
  const row = await f.DB.prepare("SELECT sent_by_employee_id FROM whatsapp_messages WHERE id = ?").bind(message.id).first();
  assert.equal(row.sent_by_employee_id, f.people.MA.id);
  // The thread is visible to the handler and the manager only.
  assert.equal((await f.json(await f.get("A1", `/v1/device/customers/${customerId}/messages`))).items[0].sentBy.name, "Manager A");
  assert.equal((await f.get("MB", `/v1/device/customers/${customerId}/messages`)).status, 404);

  // Attachments: a file the manager uploaded can go to a team customer; another employee cannot use it.
  const upload = await f.request("/v1/device/whatsapp/attachments?fileName=p.jpg", {
    method: "POST", headers: { Authorization: `Bearer ${f.people.MA.token}`, "Content-Type": "image/jpeg" }, body: jpeg(),
  });
  assert.equal(upload.status, 201);
  const attachmentId = (await f.json(upload)).attachmentId;
  const media = (who, target = customerId) => as(f, who, "POST", `/v1/device/customers/${target}/messages`, { clientMessageId: crypto.randomUUID(), type: "media", attachmentId });
  assert.equal((await media("A1")).status, 404);
  assert.equal((await media("MA", f.customers.cB1.id)).status, 404);
  assert.equal((await media("MA", f.customers.cO.id)).status, 404);
  const attached = await media("MA");
  assert.equal(attached.status, 201);
  assert.equal((await f.json(attached)).message.sentBy.id, f.people.MA.id);
});

test("media files: served from scope customers only", async (t) => {
  const f = await fixture(t);
  await f.RECORDINGS.put("whatsapp-media/wam_img_a1", jpeg(), { httpMetadata: { contentType: "image/jpeg" } });
  await f.DB.prepare(
    `INSERT INTO whatsapp_messages (id, customer_id, direction, message_type, status, sent_at, source, created_at, media_key, media_mime)
     VALUES ('wam_img_a1', ?, 'in', 'image', 'delivered', '2026-10-02T10:00:00.000Z', 'import', '2026-10-02T10:00:00.000Z', 'whatsapp-media/wam_img_a1', 'image/jpeg')`,
  ).bind(f.customers.cA1.id).run();
  const status = async (who) => (await f.get(who, "/v1/device/whatsapp/messages/wam_img_a1/media")).status;
  assert.equal(await status("A1"), 200);
  assert.equal(await status("MA"), 200);
  for (const who of ["MB", "O", "B1", "A2"]) assert.equal(await status(who), 404, who);
  const listed = await f.json(await f.get("MA", `/v1/device/customers/${f.customers.cA1.id}/messages`));
  assert.equal(listed.items.find((item) => item.id === "wam_img_a1").media.url, "/v1/device/whatsapp/messages/wam_img_a1/media");
});

test("analytics: managers cover the scope, may narrow it, and never read outside it", async (t) => {
  const f = await fixture(t);
  const analytics = async (who, query = "") => f.get(who, `/v1/device/analytics?${analyticsQuery}${query}`);
  const all = await f.json(await analytics("MA"));
  assert.equal(all.totals.total, 4);
  assert.deepEqual(all.employees.map((employee) => employee.id).sort(), [f.people.MA.id, f.people.A1.id, f.people.A2.id].sort());
  assert.ok(all.employees.every((employee) => typeof employee.name === "string" && typeof employee.total === "number"));
  assert.equal(all.byEmployee, undefined);
  assert.ok(!JSON.stringify(all).includes("Bella"));

  const grouped = await f.json(await analytics("MA", "&groupBy=employee"));
  assert.deepEqual(grouped.byEmployee.map((employee) => [employee.id, employee.total]).sort(), [[f.people.MA.id, 1], [f.people.A1.id, 2], [f.people.A2.id, 1]].sort());
  const narrowed = await f.json(await analytics("MA", `&employeeIds=${f.people.A1.id},${f.people.A2.id}`));
  assert.equal(narrowed.totals.total, 3);
  assert.equal(narrowed.employees.length, 2);
  // Whole scope includes members who made no calls (zero-filled).
  await f.DB.prepare("DELETE FROM calls WHERE employee_id = ?").bind(f.people.A2.id).run();
  await f.DB.prepare("DELETE FROM call_logs WHERE employee_id = ?").bind(f.people.A2.id).run();
  const quiet = await f.json(await analytics("MA"));
  assert.equal(quiet.employees.find((employee) => employee.id === f.people.A2.id).total, 0);
  assert.equal(quiet.byEmployee, undefined);

  for (const outside of [f.people.B1.id, f.people.O.id, f.people.MB.id, `${f.people.A1.id},${f.people.B1.id}`]) {
    const refused = await analytics("MA", `&employeeIds=${outside}`);
    assert.equal(refused.status, 400, outside);
    assert.equal((await f.json(refused)).error.code, "employee_out_of_scope");
  }
  assert.equal((await analytics("MA", "&groupBy=day")).status, 400);
  assert.equal((await f.json(await analytics("MB"))).totals.total, 2);
  // Employees keep the existing behaviour: own calls only, manager-only parameters refused.
  const own = await f.json(await analytics("A1"));
  assert.equal(own.totals.total, 2);
  assert.deepEqual(own.employees.map((employee) => employee.id), [f.people.A1.id]);
  assert.equal(own.byEmployee, undefined);
  for (const query of [`&employeeIds=${f.people.A1.id}`, "&groupBy=employee"]) {
    const refused = await analytics("A1", query);
    assert.equal(refused.status, 400);
    assert.equal((await f.json(refused)).error.code, "not_a_manager");
  }
  assert.equal((await f.json(await analytics("O"))).totals.total, 1);
});

test("call history and recordings: scope members only, playback logged", async (t) => {
  const f = await fixture(t);
  const history = async (who, query = "") => f.json(await f.get(who, `/v1/device/call-history${query}`));
  const callsOf = async (who, query) => ids((await history(who, query)).items);
  const logs = f.callLogs;
  assert.deepEqual(await callsOf("MA"), [logs.MA1, logs.A11, logs.A12, logs.A21].sort());
  assert.deepEqual(await callsOf("MA", "?employeeId=me"), [logs.MA1]);
  assert.deepEqual(await callsOf("MA", "?employeeId=team"), [logs.A11, logs.A12, logs.A21].sort());
  assert.deepEqual(await callsOf("MA", `?employeeId=${f.people.A1.id}`), [logs.A11, logs.A12].sort());
  const items = (await history("MA")).items;
  assert.ok(items.every((item) => item.employee.id && item.employee.name));
  assert.equal(items.find((item) => item.id === logs.A11).customer.name, "Cust A1");
  assert.deepEqual(await callsOf("MB"), [logs.MB1, logs.B11].sort());
  assert.deepEqual(await callsOf("A1"), [logs.A11, logs.A12].sort());
  assert.deepEqual(await callsOf("O"), [logs.O1]);
  for (const outside of [f.people.B1.id, f.people.O.id]) {
    const refused = await f.get("MA", `/v1/device/call-history?employeeId=${outside}`);
    assert.equal(refused.status, 400);
    assert.equal((await f.json(refused)).error.code, "employee_out_of_scope");
  }
  // A customer named on a call must be visible to the viewer.
  assert.equal((await history("MB")).items.some((item) => item.customer?.name === "Cust A1"), false);

  const play = (who, id) => f.get(who, `/v1/device/call-history/${id}/recording`);
  const played = await play("MA", logs.A11);
  assert.equal(played.status, 200);
  const grant = await f.json(played);
  assert.equal(grant.contentType, "audio/mp4");
  const audioUrl = new URL(grant.url);
  const audio = await f.request(audioUrl.pathname + audioUrl.search, { headers: { Authorization: `Bearer ${f.people.MA.token}` } });
  assert.equal(audio.status, 200);
  assert.equal((await f.request(audioUrl.pathname + audioUrl.search, { headers: { Authorization: `Bearer ${f.people.MB.token}` } })).status, 404);
  assert.equal((await f.request(audioUrl.pathname + audioUrl.search)).status, 401);
  for (const [who, id] of [["MB", logs.A11], ["O", logs.A11], ["A1", logs.A11], ["MA", logs.B11], ["MA", logs.O1], ["MB", logs.O1]]) {
    assert.equal((await play(who, id)).status, 404, `${who} ${id}`);
  }
  assert.equal((await play("MB", logs.B11)).status, 200);
  const logged = await f.DB.prepare("SELECT actor_id, details FROM activity_log WHERE action = 'recording_played' ORDER BY occurred_at").all();
  assert.deepEqual(logged.results.map((row) => row.actor_id), [f.people.MA.id, f.people.MB.id]);
});

test("lookup: 'mine' means in my scope and managers also learn the handlers", async (t) => {
  const f = await fixture(t);
  const lookup = async (who, phone) => f.json(await f.get(who, `/v1/device/customers/lookup?phone=${phone}`));
  const manager = await lookup("MA", "9800000001");
  assert.equal(manager.mine, true);
  assert.equal(manager.customer.id, f.customers.cA1.id);
  assert.deepEqual(manager.handlers, [{ id: f.people.A1.id, name: "Alice A1" }]);
  const shared = await lookup("MA", "9800000004");
  assert.deepEqual(shared.handlers.map((handler) => handler.name), ["Alice A1", "Olive Outsider"]);
  const other = await lookup("MB", "9800000001");
  assert.deepEqual([other.exists, other.mine, other.customer, other.handlers], [true, false, undefined, undefined]);
  const employee = await lookup("A1", "9800000004");
  assert.equal(employee.mine, true);
  assert.equal("handlers" in employee, false);
  const stranger = await lookup("A2", "9800000001");
  assert.deepEqual([stranger.phone, stranger.exists, stranger.mine, stranger.customer], ["+919800000001", true, false, undefined]);
});

test("adding and editing customers: a manager acts for the team, never beyond", async (t) => {
  const f = await fixture(t);
  const create = (who, body) => as(f, who, "POST", "/v1/device/customers", body);
  const forTeam = await create("MA", { name: "New for A2", phone: "9811111111", employeeId: f.people.A2.id });
  assert.equal(forTeam.status, 201);
  const created = (await f.json(forTeam)).customer;
  assert.deepEqual(created.employees.map((employee) => employee.id), [f.people.A2.id]);
  assert.equal(created.createdBy.id, f.people.MA.id);
  assert.equal(created.scope, "team");
  assert.equal(f.pushes.length, 0);
  const own = await create("MA", { name: "Mine", phone: "9822222222" });
  assert.equal((await f.json(own)).customer.employees[0].id, f.people.MA.id);
  for (const body of [{ employeeId: f.people.B1.id }, { employeeId: f.people.O.id }, { employeeId: "emp_nobody" }, { employeeId: 5 }]) {
    const refused = await create("MA", { name: "No", phone: "9833333333", ...body });
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal((await f.json(refused)).error.code, "employee_out_of_scope");
  }
  const forbidden = await create("A1", { name: "No", phone: "9844444444", employeeId: f.people.A1.id });
  assert.equal(forbidden.status, 400);
  assert.equal((await f.json(forbidden)).error.code, "not_a_manager");
  // A number held by a customer in the manager's scope is identified; one held elsewhere is a bare conflict.
  const inScope = await f.json(await create("MA", { name: "Dup", phone: "9800000001" }));
  assert.equal(inScope.customerId, f.customers.cA1.id);
  const elsewhere = await create("MA", { name: "Dup", phone: "9800000005" });
  assert.equal(elsewhere.status, 409);
  assert.equal((await f.json(elsewhere)).customerId, undefined);

  const patch = (who, id, body) => as(f, who, "PATCH", `/v1/device/customers/${id}`, body);
  const edited = await patch("MA", f.customers.cA1.id, { name: "Renamed", notes: "note" });
  assert.equal(edited.status, 200);
  assert.equal((await f.json(edited)).customer.name, "Renamed");
  assert.equal((await patch("MA", f.customers.cA1.id, { phone: "9899999999" })).status, 400);
  for (const who of ["MB", "O", "A2"]) assert.equal((await patch(who, f.customers.cA1.id, { name: "Hijack" })).status, 404, who);
  assert.equal((await f.json(await f.get("A1", `/v1/device/customers/${f.customers.cA1.id}`))).customer.name, "Renamed");
});

test("handover: scope-only changes, outside handlers preserved, pushes and activity", async (t) => {
  const f = await fixture(t);
  const token = (key) => `fcm-token-${key}`.padEnd(40, "x");
  for (const key of ["MA", "A1", "A2", "O"]) {
    assert.equal((await as(f, key, "PUT", "/v1/device/push-token", { token: token(key) })).status, 200);
  }
  const handlers = (who, id, employeeIds) => as(f, who, "PUT", `/v1/device/customers/${id}/handlers`, { employeeIds });
  const shared = f.customers.cShared;

  // Hand A1's share of the shared customer to A2: Olive (outside) stays.
  const moved = await handlers("MA", shared.id, [f.people.A2.id]);
  assert.equal(moved.status, 200);
  const body = (await f.json(moved)).customer;
  assert.deepEqual(body.employees.map((employee) => employee.id).sort(), [f.people.A2.id, f.people.O.id].sort());
  assert.equal(body.scope, "team");
  assert.deepEqual(f.pushes.map((push) => push.token), [token("A2")]);
  assert.equal(f.pushes[0].data.type, "assigned");
  const activity = await f.DB.prepare("SELECT actor_id, actor_name, channel, category, target_id, details FROM activity_log WHERE action = 'customers_handed_over'").all();
  assert.equal(activity.results.length, 1);
  assert.equal(activity.results[0].actor_id, f.people.MA.id);
  assert.equal(activity.results[0].target_id, shared.id);
  assert.deepEqual(JSON.parse(activity.results[0].details), { added: 1, removed: 1, to: ["Anna A2"], from: ["Alice A1"] });

  // Repeating the same set changes nothing: no push, no new log row.
  assert.equal((await handlers("MA", shared.id, [f.people.A2.id])).status, 200);
  assert.equal(f.pushes.length, 1);
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM activity_log WHERE action = 'customers_handed_over'").first()).n, 1);

  // The manager taking a customer is not pushed; the outside handler is untouched.
  f.pushes.length = 0;
  const own = await handlers("MA", shared.id, [f.people.A2.id, f.people.MA.id]);
  assert.equal(own.status, 200);
  assert.equal(f.pushes.length, 0);
  assert.equal((await f.json(own)).customer.scope, "own");
  // An empty set is fine while an outside handler remains.
  assert.equal((await handlers("MA", shared.id, [])).status, 200);
  const left = await f.DB.prepare("SELECT employee_id FROM customer_employees WHERE customer_id = ?").bind(shared.id).all();
  assert.deepEqual(left.results.map((row) => row.employee_id), [f.people.O.id]);
  // ...and the shared customer is now out of the manager's scope.
  assert.equal((await f.get("MA", `/v1/device/customers/${shared.id}`)).status, 404);
  assert.equal((await handlers("MA", shared.id, [f.people.A1.id])).status, 404);

  // Cannot leave a customer without any handler.
  const alone = await handlers("MA", f.customers.cA1.id, []);
  assert.equal(alone.status, 409);
  assert.equal((await f.json(alone)).error.code, "handler_required");
  assert.deepEqual((await f.DB.prepare("SELECT employee_id FROM customer_employees WHERE customer_id = ?").bind(f.customers.cA1.id).all()).results.map((row) => row.employee_id), [f.people.A1.id]);

  // Out-of-scope ids are refused, whatever else is in the request.
  for (const outside of [f.people.B1.id, f.people.O.id, f.people.MB.id, "emp_nobody"]) {
    const refused = await handlers("MA", f.customers.cA1.id, [f.people.A1.id, outside]);
    assert.equal(refused.status, 400, outside);
    assert.equal((await f.json(refused)).error.code, "employee_out_of_scope");
  }
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM customer_employees WHERE customer_id = ?").bind(f.customers.cA1.id).first()).n, 1);
  assert.equal((await as(f, "MA", "PUT", `/v1/device/customers/${f.customers.cA1.id}/handlers`, { employeeIds: [f.people.A1.id], extra: 1 })).status, 400);

  // Customers of other teams cannot be touched; employees and unrelated managers get nothing.
  assert.equal((await handlers("MA", f.customers.cB1.id, [f.people.A1.id])).status, 404);
  assert.equal((await handlers("MB", f.customers.cA1.id, [f.people.B1.id])).status, 404);
  assert.equal((await handlers("MA", f.customers.cO.id, [f.people.A1.id])).status, 404);
  for (const who of ["A1", "O", "B1"]) {
    const refused = await handlers(who, f.customers.cA1.id, [f.people[who].id]);
    assert.equal(refused.status, 400, who);
    assert.equal((await f.json(refused)).error.code, "not_a_manager");
  }
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM customer_employees WHERE customer_id = ?").bind(f.customers.cB1.id).first()).n, 1);
  // A customer shared between two teams: each manager only moves their own team's handlers.
  const cross = await handlers("MA", f.customers.cAB.id, [f.people.A2.id]);
  assert.equal(cross.status, 200);
  assert.deepEqual((await f.json(cross)).customer.employees.map((employee) => employee.id).sort(), [f.people.A2.id, f.people.B1.id].sort());
});

test("profile: role, manager and team (active reports only)", async (t) => {
  const f = await fixture(t);
  const profile = async (who) => (await f.json(await f.get(who, "/v1/device/profile"))).employee;
  const manager = await profile("MA");
  assert.equal(manager.role, "manager");
  assert.equal(manager.managerId, null);
  assert.deepEqual(manager.team.map((member) => [member.name, member.phoneNumber]), [["Alice A1", null], ["Anna A2", null]]);
  const report = await profile("A1");
  assert.deepEqual([report.role, report.managerId, report.team], ["employee", f.people.MA.id, []]);
  assert.deepEqual(await profile("O").then((value) => [value.role, value.managerId, value.team]), ["employee", null, []]);
  // An inactive report leaves the team (and the manager's scope).
  await f.DB.prepare("UPDATE employees SET active = 0 WHERE id = ?").bind(f.people.A2.id).run();
  assert.deepEqual((await profile("MA")).team.map((member) => member.name), ["Alice A1"]);
  assert.deepEqual(ids((await f.json(await f.get("MA", "/v1/device/customers"))).items), expectIds(f, ["cA1", "cMA", "cShared", "cAB"]));
});

test("unauthenticated and revoked callers get nothing", async (t) => {
  const f = await fixture(t);
  for (const path of ["/v1/device/customers", "/v1/device/analytics", "/v1/device/call-history", "/v1/device/whatsapp/chats", "/v1/device/profile"]) {
    assert.equal((await f.request(path)).status, 401, path);
  }
  assert.equal((await f.request(`/v1/device/customers/${f.customers.cA1.id}/handlers`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{\"employeeIds\":[]}" })).status, 401);
});

test("push: a manager hears about the team's customers only when the setting is on", async (t) => {
  const f = await fixture(t);
  const token = (key) => `fcm-token-${key}`.padEnd(40, "x");
  for (const key of ["MA", "A1", "MB"]) assert.equal((await as(f, key, "PUT", "/v1/device/push-token", { token: token(key) })).status, 200);
  const { notifyNewMessage } = await loadModule("../push/notify.ts");
  await notifyNewMessage(f.env, f.customers.cA1.id);
  assert.deepEqual(f.pushes.map((push) => push.token), [token("A1")]);
  // The admin turns it on for manager A.
  f.pushes.length = 0;
  const on = await f.admin("PATCH", `/v1/admin/employees/${f.people.MA.id}`, { notifyTeamMessages: true });
  assert.equal(on.status, 200);
  assert.equal((await f.json(on)).employee.notifyTeamMessages, true);
  await notifyNewMessage(f.env, f.customers.cA1.id);
  assert.deepEqual(f.pushes.map((push) => push.token).sort(), [token("A1"), token("MA")].sort());
  f.pushes.length = 0;
  await notifyNewMessage(f.env, f.customers.cB1.id);
  assert.deepEqual(f.pushes.map((push) => push.token), []);
  await notifyNewMessage(f.env, f.customers.cMA.id);
  assert.deepEqual(f.pushes.map((push) => push.token), [token("MA")]);
  // Inactive managers are never pushed.
  f.pushes.length = 0;
  await f.DB.prepare("UPDATE employees SET active = 0 WHERE id = ?").bind(f.people.MA.id).run();
  await notifyNewMessage(f.env, f.customers.cA1.id);
  assert.deepEqual(f.pushes.map((push) => push.token), [token("A1")]);
});

test("hierarchy rules through the admin API", async (t) => {
  const f = await fixture(t);
  const patch = (key, body) => f.admin("PATCH", `/v1/admin/employees/${f.people[key].id}`, body);
  const code = async (response) => (await f.json(response)).error?.code;

  // The listing carries role, manager, team size.
  const listed = (await f.json(await f.admin("GET", "/v1/admin/employees?limit=100"))).items;
  const row = (key) => listed.find((employee) => employee.id === f.people[key].id);
  assert.deepEqual([row("MA").role, row("MA").teamSize, row("MA").managerId, row("MA").notifyTeamMessages], ["manager", 2, null, false]);
  assert.deepEqual([row("A1").role, row("A1").managerId, row("A1").managerName, row("A1").teamSize], ["employee", f.people.MA.id, "Manager A", 0]);

  // Single level.
  let refused = await patch("MB", { managerId: f.people.MA.id });
  assert.deepEqual([refused.status, await code(refused)], [400, "manager_cannot_report"]);
  refused = await patch("O", { managerId: f.people.A1.id });
  assert.deepEqual([refused.status, await code(refused)], [400, "invalid_manager"]);
  refused = await patch("O", { managerId: f.people.O.id });
  assert.deepEqual([refused.status, await code(refused)], [400, "invalid_manager"]);
  refused = await patch("O", { managerId: "emp_nobody" });
  assert.deepEqual([refused.status, await code(refused)], [400, "invalid_manager"]);
  refused = await patch("O", { role: "manager", managerId: f.people.MA.id });
  assert.deepEqual([refused.status, await code(refused)], [400, "manager_cannot_report"]);
  refused = await f.admin("POST", "/v1/admin/employees", { name: "X", role: "manager", managerId: f.people.MA.id });
  assert.deepEqual([refused.status, await code(refused)], [400, "manager_cannot_report"]);
  refused = await f.admin("POST", "/v1/admin/employees", { name: "X", managerId: f.people.O.id });
  assert.deepEqual([refused.status, await code(refused)], [400, "invalid_manager"]);
  refused = await patch("O", { moveTeamTo: f.people.MB.id });
  assert.equal(refused.status, 400);
  // Inactive managers cannot take reports.
  await f.DB.prepare("UPDATE employees SET active = 0 WHERE id = ?").bind(f.people.MB.id).run();
  refused = await patch("O", { managerId: f.people.MB.id });
  assert.deepEqual([refused.status, await code(refused)], [400, "invalid_manager"]);
  await f.DB.prepare("UPDATE employees SET active = 1 WHERE id = ?").bind(f.people.MB.id).run();

  // An employee can be assigned, moved and cleared.
  let ok = await patch("O", { managerId: f.people.MB.id });
  assert.equal(ok.status, 200);
  assert.equal((await f.json(ok)).employee.managerName, "Manager B");
  ok = await patch("O", { managerId: null });
  assert.equal((await f.json(ok)).employee.managerId, null);

  // Promoting a report ends their reporting line; demoting needs the team moved first.
  ok = await patch("A1", { role: "manager" });
  assert.equal(ok.status, 200);
  assert.deepEqual([(await f.json(ok)).employee.managerId], [null]);
  ok = await patch("A1", { role: "employee", managerId: f.people.MA.id });
  assert.equal(ok.status, 200);
  refused = await patch("MA", { role: "employee" });
  assert.deepEqual([refused.status, await code(refused)], [409, "manager_has_team"]);
  assert.equal((await f.DB.prepare("SELECT role FROM employees WHERE id = ?").bind(f.people.MA.id).first()).role, "manager");
  // Moving the team to a non-manager or to themselves is refused.
  refused = await patch("MA", { role: "employee", moveTeamTo: f.people.O.id });
  assert.deepEqual([refused.status, await code(refused)], [400, "invalid_manager"]);
  refused = await patch("MA", { role: "employee", moveTeamTo: f.people.MA.id });
  assert.deepEqual([refused.status, await code(refused)], [400, "invalid_manager"]);
  ok = await patch("MA", { role: "employee", moveTeamTo: f.people.MB.id });
  assert.equal(ok.status, 200);
  const moved = await f.DB.prepare("SELECT id, manager_id FROM employees WHERE id IN (?, ?)").bind(f.people.A1.id, f.people.A2.id).all();
  assert.ok(moved.results.every((report) => report.manager_id === f.people.MB.id));
  assert.equal((await f.json(await f.get("MB", "/v1/device/profile"))).employee.team.length, 3);
  // The old manager is just an employee: no scope beyond their own customers.
  assert.deepEqual(ids((await f.json(await f.get("MA", "/v1/device/customers"))).items), expectIds(f, ["cMA"]));
  assert.equal((await f.get("MA", "/v1/device/customers?employeeId=team")).status, 400);

  // Clearing: reports are left without a manager.
  ok = await patch("MB", { role: "employee", moveTeamTo: null });
  assert.equal(ok.status, 200);
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM employees WHERE manager_id IS NOT NULL").first()).n, 0);

  // Inactive reports do not block a demotion and are detached too.
  await patch("MA", { role: "manager" });
  await patch("A1", { managerId: f.people.MA.id });
  await f.DB.prepare("UPDATE employees SET active = 0 WHERE id = ?").bind(f.people.A1.id).run();
  ok = await patch("MA", { role: "employee" });
  assert.equal(ok.status, 200);
  assert.equal((await f.DB.prepare("SELECT manager_id FROM employees WHERE id = ?").bind(f.people.A1.id).first()).manager_id, null);

  // Activity trail.
  const actions = (await f.DB.prepare("SELECT action, actor_type, channel, target_id, details FROM activity_log WHERE action IN ('role_changed', 'manager_changed', 'team_detached') ORDER BY occurred_at, id").all()).results;
  assert.ok(actions.some((entry) => entry.action === "role_changed" && JSON.parse(entry.details).to === "manager"));
  assert.ok(actions.some((entry) => entry.action === "manager_changed" && JSON.parse(entry.details).to === "Manager B"));
  const detached = actions.filter((entry) => entry.action === "team_detached");
  assert.ok(detached.length >= 1);
  assert.ok(actions.every((entry) => entry.actor_type === "admin" && entry.channel === "admin"));
});

test("a team holds at most 50 active reports", async (t) => {
  const f = await fixture(t);
  const statements = [];
  for (let n = 0; n < 48; n += 1) {
    statements.push(f.DB.prepare("INSERT INTO employees (id, name, created_at, manager_id) VALUES (?, ?, '2026-01-01T00:00:00.000Z', ?)")
      .bind(`emp_bulk_${n}`, `Bulk ${n}`, f.people.MA.id));
  }
  await f.DB.batch(statements);
  const refused = await f.admin("PATCH", `/v1/admin/employees/${f.people.O.id}`, { managerId: f.people.MA.id });
  assert.equal(refused.status, 409);
  assert.equal((await f.json(refused)).error.code, "team_full");
  // 50 reports are all inside the manager's scope.
  const scope = await f.json(await f.get("MA", "/v1/device/profile"));
  assert.equal(scope.employee.team.length, 50);
  const customers = await f.get("MA", "/v1/device/customers");
  assert.equal(customers.status, 200);
  assert.equal((await f.get("MA", `/v1/device/analytics?${analyticsQuery}`)).status, 200);
});

test("deactivating a manager detaches their reports", async (t) => {
  const f = await fixture(t);
  await f.identity.setEmployeeActive(f.people.MA.id, false);
  const reports = await f.DB.prepare("SELECT manager_id FROM employees WHERE id IN (?, ?)").bind(f.people.A1.id, f.people.A2.id).all();
  assert.ok(reports.results.every((row) => row.manager_id === null));
  // A reactivated manager starts with an empty team.
  await f.identity.setEmployeeActive(f.people.MA.id, true);
  assert.deepEqual((await f.json(await f.get("MA", "/v1/device/profile"))).employee.team, []);
});

test("database guards keep the hierarchy valid even for direct writes", async (t) => {
  const f = await fixture(t);
  const write = (sql, ...binds) => f.DB.prepare(sql).bind(...binds).run();
  await assert.rejects(write("UPDATE employees SET manager_id = ? WHERE id = ?", f.people.A1.id, f.people.O.id), /invalid_manager/);
  await assert.rejects(write("UPDATE employees SET manager_id = ? WHERE id = ?", f.people.MA.id, f.people.MB.id), /invalid_manager/);
  await assert.rejects(write("UPDATE employees SET role = 'employee' WHERE id = ?", f.people.MA.id), /manager_has_team/);
  await assert.rejects(write("INSERT INTO employees (id, name, created_at, manager_id) VALUES ('emp_x', 'X', '2026-01-01T00:00:00.000Z', ?)", f.people.O.id), /invalid_manager/);
});

test("the admin Employees tab script stays valid and knows the manager flows", async () => {
  const { clientJavaScript } = await loadModule("../admin-ui/client.ts");
  assert.doesNotThrow(() => new Function(clientJavaScript));
  for (const word of ["moveTeamTo", "manager_has_team", "notifyTeamMessages", "customers_handed_over", "role_changed", "team_detached", "manager_changed"]) {
    assert.ok(clientJavaScript.includes(word), word);
  }
});

test("web app: the cookie session gets the same scope, profile, handover and playback", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.admin("PUT", "/v1/admin/settings/employeeWeb", { enabled: true })).status, 200);
  let ip = 20;
  const sessions = {};
  const web = (who, path, { method = "GET", body } = {}) => f.request(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(sessions[who] && method !== "GET" ? { "X-Linekeep-CSRF": sessions[who].csrf } : {}),
      ...(sessions[who] ? { Cookie: sessions[who].cookie } : {}),
      "CF-Connecting-IP": "203.0.113.5",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const who of ["MA", "O"]) {
    const email = `${who.toLowerCase()}@example.test`;
    assert.equal((await f.admin("PATCH", `/v1/admin/employees/${f.people[who].id}`, { email })).status, 200);
    const asked = await f.request("/v1/web/auth/request", {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": `203.0.113.${ip++}` }, body: JSON.stringify({ method: "email", email }),
    });
    assert.equal(asked.status, 202);
    const code = f.mails.at(-1).match(/\b(\d{6})\b/)[1];
    const verified = await f.request("/v1/web/auth/verify", {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.5" }, body: JSON.stringify({ method: "email", email, code }),
    });
    assert.equal(verified.status, 200);
    const body = await f.json(verified);
    sessions[who] = { cookie: verified.headers.get("set-cookie").split(";")[0], csrf: body.csrfToken };
    // The sign-in body already carries the role and team.
    assert.equal(body.employee.role, who === "MA" ? "manager" : "employee");
    assert.deepEqual(body.employee.team.map((member) => member.name), who === "MA" ? ["Alice A1", "Anna A2"] : []);
  }
  const session = await f.json(await web("MA", "/v1/web/session"));
  assert.deepEqual([session.employee.role, session.employee.managerId, session.employee.team.length], ["manager", null, 2]);
  const profile = (await f.json(await web("MA", "/v1/web/profile"))).employee;
  assert.deepEqual([profile.role, profile.team.length], ["manager", 2]);

  const customers = await f.json(await web("MA", "/v1/web/customers"));
  assert.deepEqual(ids(customers.items), expectIds(f, ["cA1", "cA2", "cMA", "cShared", "cAB"]));
  assert.deepEqual(ids((await f.json(await web("O", "/v1/web/customers"))).items), expectIds(f, ["cShared", "cO"]));
  assert.equal((await web("O", "/v1/web/customers?employeeId=me")).status, 400);
  assert.equal((await web("MA", `/v1/web/customers/${f.customers.cB1.id}`)).status, 404);
  assert.deepEqual(ids((await f.json(await web("MA", "/v1/web/customers?employeeId=team"))).items), expectIds(f, ["cA1", "cA2", "cShared", "cAB"]));
  // Calls with a customer: scope members' calls, narrowed by the filter.
  const calls = await f.json(await web("MA", `/v1/web/customers/${f.customers.cA1.id}/calls`));
  assert.deepEqual(ids(calls.items), [f.callLogs.A11]);
  assert.equal((await web("MA", `/v1/web/customers/${f.customers.cB1.id}/calls`)).status, 404);
  assert.deepEqual((await f.json(await web("MA", `/v1/web/customers/${f.customers.cA1.id}/calls?employeeId=me`))).items, []);
  assert.equal((await web("MA", `/v1/web/analytics?${analyticsQuery}&groupBy=employee`)).status, 200);
  assert.equal((await web("O", `/v1/web/analytics?${analyticsQuery}&employeeIds=${f.people.O.id}`)).status, 400);
  assert.deepEqual(ids((await f.json(await web("MA", "/v1/web/call-history?employeeId=team"))).items), [f.callLogs.A11, f.callLogs.A12, f.callLogs.A21].sort());

  // Playback of a team recording is allowed for the manager, not for the outsider or the other manager.
  assert.equal((await web("MA", `/v1/web/call-history/${f.callLogs.A11}/recording`)).status, 200);
  assert.equal((await web("O", `/v1/web/call-history/${f.callLogs.A11}/recording`)).status, 404);
  assert.equal((await web("MA", `/v1/web/call-history/${f.callLogs.B11}/recording`)).status, 404);

  // Handover over the web needs the CSRF header like every change.
  const path = `/v1/web/customers/${f.customers.cA1.id}/handlers`;
  const withoutCsrf = await f.request(path, {
    method: "PUT", headers: { "Content-Type": "application/json", Cookie: sessions.MA.cookie }, body: JSON.stringify({ employeeIds: [f.people.A2.id] }),
  });
  assert.equal(withoutCsrf.status, 403);
  const handed = await web("MA", path, { method: "PUT", body: { employeeIds: [f.people.A2.id] } });
  assert.equal(handed.status, 200);
  assert.deepEqual((await f.json(handed)).customer.employees.map((employee) => employee.id), [f.people.A2.id]);
  assert.equal((await web("O", path, { method: "PUT", body: { employeeIds: [f.people.O.id] } })).status, 400);
  const row = await f.DB.prepare("SELECT channel FROM activity_log WHERE action = 'customers_handed_over'").first();
  assert.equal(row.channel, "web");
  // Creating for a team member from the web.
  const created = await web("MA", "/v1/web/customers", { method: "POST", body: { name: "Web New", phone: "9855555555", employeeId: f.people.A1.id } });
  assert.equal(created.status, 201);
  assert.equal((await f.json(created)).customer.employees[0].id, f.people.A1.id);
});
