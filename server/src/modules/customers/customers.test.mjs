import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { createIdentityRepository } = await loadModule("./identity.ts");
const { createCallRepository } = await loadModule("./calls.ts");
const { normalizePhone } = await loadModule("./customers.ts");
const adminSecret = "synthetic-customers-admin-secret-not-for-deployment";
const tokenSecret = "synthetic-customers-token-secret-not-for-deployment";
const start = "2026-09-24T12:00:00.000Z";
const admin = { Authorization: `Bearer ${adminSecret}` };

async function fixture(t) {
  const DB = await createDatabase(t);
  const identity = createIdentityRepository(DB, tokenSecret, () => new Date(start));
  const alice = await identity.createEmployee({ name: "Alice Synthetic" });
  const bob = await identity.createEmployee({ name: "Bob Synthetic" });
  const enroll = async (employee) => identity.redeemInvitation(
    (await identity.createInvitation(employee.id, "2026-09-25T00:00:00Z")).invitationCode,
    { model: "Synthetic device" },
  );
  const aliceDevice = await enroll(alice);
  const bobDevice = await enroll(bob);
  const env = { DB, TOKEN_HASH_SECRET: tokenSecret, LOCAL_ADMIN_SECRET: adminSecret, ENVIRONMENT: "development" };
  const app = createApp();
  const request = (path, options = {}) => app.request(new URL(path, "http://127.0.0.1"), options, env);
  const json = (body) => ({ "Content-Type": "application/json", body: JSON.stringify(body) });
  const adminCall = (method, path, body) => request(path, {
    method, headers: { ...admin, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const deviceCall = (enrolled, path, method = "GET", body) => request(path, {
    method,
    headers: { Authorization: `Bearer ${enrolled.deviceToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const create = async (body) => {
    const response = await adminCall("POST", "/v1/admin/customers", body);
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).customer;
  };
  let sequence = 0;
  const addMessage = async (customerId, extra = {}) => {
    sequence += 1;
    await DB.prepare(
      `INSERT INTO whatsapp_messages (id, customer_id, direction, message_type, body, status, sent_at, source, created_at)
       VALUES (?, ?, ?, 'text', ?, 'delivered', ?, 'import', ?)`,
    ).bind(`wam_${sequence}`, customerId, extra.direction ?? "in", extra.body ?? `message ${sequence}`,
      extra.sentAt ?? `2026-09-24T10:00:${String(sequence).padStart(2, "0")}.000Z`, start).run();
    return `wam_${sequence}`;
  };
  const logCalls = (enrolled, entries) => request("/v1/device/call-logs/batch", {
    method: "POST",
    headers: { Authorization: `Bearer ${enrolled.deviceToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: enrolled.device.id, entries }),
  });
  return { DB, identity, alice, bob, aliceDevice, bobDevice, request, json, adminCall, deviceCall, create, addMessage, logCalls };
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.equal(body.requestId, response.headers.get("X-Request-Id"));
  return body;
}

function logEntry(index, extra = {}) {
  return {
    fingerprint: index.toString(16).padStart(64, "0"),
    startedAt: `2026-09-24T11:00:${String(index).padStart(2, "0")}Z`,
    durationSeconds: 20, callType: "incoming", ...extra,
  };
}

test("phone normalization boundaries follow the contract", () => {
  const cases = [
    ["98765 43210", "+919876543210", "9876543210"],
    ["(987) 654-3210", "+919876543210", "9876543210"],
    ["09876543210", "+919876543210", "9876543210"],
    ["+91 98765-43210", "+919876543210", "9876543210"],
    ["+1 (555) 010-1234", "+15550101234", "5550101234"],
    ["12345678", "+12345678", "12345678"],
    ["123456789012345", "+123456789012345", "6789012345"],
    ["19876543210", "+19876543210", "9876543210"],
  ];
  for (const [input, phone, phoneKey] of cases) {
    assert.deepEqual(normalizePhone(input), { phone, phoneKey }, input);
  }
  for (const input of ["1234567", "1234567890123456", "", "abc", "+91"]) {
    assert.equal(normalizePhone(input), null, input);
  }
});

test("customers validate input, reject duplicate live phones and allow reuse after archiving", async (t) => {
  const f = await fixture(t);
  const first = await f.create({ name: "  Asha Synthetic  ", phone: "98765 43210", email: "asha@example.test", notes: "", employeeIds: [f.alice.id, f.alice.id] });
  assert.equal(first.name, "Asha Synthetic");
  assert.equal(first.phone, "+919876543210");
  assert.equal(first.country, "India");
  assert.equal("notes" in first, false);
  assert.deepEqual(first.employees, [{ id: f.alice.id, name: f.alice.name }]);
  assert.equal(first.messageCount, 0);

  // A different format of the same number is the same customer.
  await expectError(await f.adminCall("POST", "/v1/admin/customers", { name: "Duplicate", phone: "+91-9876543210" }), 409, "CUSTOMER_PHONE_EXISTS");
  for (const body of [
    { name: "", phone: "9876543211" }, { phone: "9876543211" }, { name: "No phone" },
    { name: "Bad", phone: "1234567" }, { name: "Bad", phone: "9876543211", extra: 1 },
    { name: "Bad", phone: "9876543211", email: "not-an-email" },
    { name: "Bad", phone: "9876543211", notes: "x".repeat(4001) },
    { name: "Bad", phone: "9876543211", employeeIds: ["emp_missing"] },
  ]) await expectError(await f.adminCall("POST", "/v1/admin/customers", body), 400, "INVALID_REQUEST");

  const archived = await (await f.adminCall("DELETE", `/v1/admin/customers/${first.id}`)).json();
  assert.equal(archived.status, "archived");
  assert.equal((await (await f.adminCall("DELETE", `/v1/admin/customers/${first.id}`)).json()).status, "archived");
  await expectError(await f.adminCall("GET", `/v1/admin/customers/${first.id}`), 404, "NOT_FOUND");
  await expectError(await f.adminCall("DELETE", "/v1/admin/customers/cus_unknown"), 404, "NOT_FOUND");
  assert.deepEqual((await (await f.adminCall("GET", "/v1/admin/customers")).json()).items, []);
  const reused = await f.create({ name: "Reused number", phone: "9876543210" });
  assert.notEqual(reused.id, first.id);
});

test("PATCH is partial, null clears optional fields and phone changes recheck uniqueness", async (t) => {
  const f = await fixture(t);
  const one = await f.create({
    name: "Patch One", phone: "9876543210", email: "one@example.test", notes: "note",
    source: "web", district: "Pune", state: "Maharashtra", country: "Nepal",
  });
  const two = await f.create({ name: "Patch Two", phone: "9876543211" });
  const patch = (id, body) => f.adminCall("PATCH", `/v1/admin/customers/${id}`, body);

  const cleared = (await (await patch(one.id, { email: null, notes: null, source: null, district: "", state: null, country: null })).json()).customer;
  for (const field of ["email", "notes", "source", "district", "state"]) assert.equal(field in cleared, false, field);
  assert.equal(cleared.country, "India");
  assert.equal(cleared.name, "Patch One");

  const renamed = (await (await patch(one.id, { name: "Renamed" })).json()).customer;
  assert.equal(renamed.name, "Renamed");
  assert.equal(renamed.phone, "+919876543210");
  await expectError(await patch(one.id, { phone: "9876543211" }), 409, "CUSTOMER_PHONE_EXISTS");
  assert.equal((await (await patch(one.id, { phone: "09876543210" })).json()).customer.phone, "+919876543210");
  assert.equal((await (await patch(two.id, { phone: "+1 555 010 1234" })).json()).customer.phone, "+15550101234");
  for (const body of [{}, { name: null }, { phone: null }, { unknown: 1 }, { phone: "123" }]) {
    await expectError(await patch(one.id, body), 400, "INVALID_REQUEST");
  }
  await expectError(await patch("cus_unknown", { name: "x" }), 404, "NOT_FOUND");
});

test("employee assignment replaces the set and only admits active employees", async (t) => {
  const f = await fixture(t);
  const inactive = await f.identity.createEmployee({ name: "Inactive Synthetic" });
  const customer = await f.create({ name: "Assigned", phone: "9876543210", employeeIds: [f.alice.id] });
  const put = (id, employeeIds) => f.adminCall("PUT", `/v1/admin/customers/${id}/employees`, { employeeIds });

  await f.identity.setEmployeeActive(inactive.id, false);
  await expectError(await put(customer.id, [f.bob.id, inactive.id]), 400, "INVALID_REQUEST");
  await expectError(await put(customer.id, ["emp_missing"]), 400, "INVALID_REQUEST");
  await expectError(await f.adminCall("POST", "/v1/admin/customers", { name: "Nope", phone: "9876543299", employeeIds: [inactive.id] }), 400, "INVALID_REQUEST");
  assert.deepEqual((await (await f.adminCall("GET", `/v1/admin/customers/${customer.id}`)).json()).customer.employees.map((e) => e.id), [f.alice.id]);

  const both = (await (await put(customer.id, [f.bob.id, f.alice.id])).json()).customer;
  assert.deepEqual(both.employees.map((e) => e.id).sort(), [f.alice.id, f.bob.id].sort());
  const onlyBob = (await (await put(customer.id, [f.bob.id])).json()).customer;
  assert.deepEqual(onlyBob.employees, [{ id: f.bob.id, name: f.bob.name }]);
  assert.deepEqual((await (await put(customer.id, [])).json()).customer.employees, []);
  await expectError(await put("cus_unknown", []), 404, "NOT_FOUND");
  await expectError(await put(customer.id, Array.from({ length: 51 }, (_, i) => `emp_${i}`)), 400, "INVALID_REQUEST");

  const unassigned = await (await f.adminCall("GET", "/v1/admin/customers?unassigned=true")).json();
  assert.deepEqual(unassigned.items.map((c) => c.id), [customer.id]);
  await put(customer.id, [f.alice.id]);
  assert.deepEqual((await (await f.adminCall("GET", "/v1/admin/customers?unassigned=true")).json()).items, []);
  assert.equal((await (await f.adminCall("GET", `/v1/admin/customers?employeeId=${f.alice.id}`)).json()).items.length, 1);
  assert.equal((await (await f.adminCall("GET", `/v1/admin/customers?employeeId=${f.bob.id}`)).json()).items.length, 0);
  await expectError(await f.adminCall("GET", `/v1/admin/customers?unassigned=true&employeeId=${f.bob.id}`), 400, "INVALID_REQUEST");
});

test("admin listing is guarded, strict, literal in search and paginates past the limit", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/v1/admin/customers")).status, 401);
  assert.equal((await f.request("/v1/admin/whatsapp/chats")).status, 401);
  const created = [];
  for (let index = 0; index < 5; index += 1) {
    created.push(await f.create({
      name: index === 0 ? "100% Literal_Name" : `Customer ${index}`, phone: `98765432${index}0`,
      email: index === 1 ? "Mixed.Case@Example.test" : undefined,
      source: index % 2 ? "web" : "walk-in", state: index % 2 ? "Kerala" : "Goa",
    }));
    await f.adminCall("PATCH", `/v1/admin/customers/${created[index].id}`, { notes: `touch ${index}` });
  }
  const seen = [];
  let path = "/v1/admin/customers?limit=2";
  for (let pages = 0; pages < 5 && path; pages += 1) {
    const page = await (await f.adminCall("GET", path)).json();
    assert.ok(page.items.length <= 2);
    seen.push(...page.items.map((c) => c.id));
    path = page.nextCursor ? `/v1/admin/customers?limit=2&cursor=${page.nextCursor}` : null;
  }
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5);

  const ids = async (query) => (await (await f.adminCall("GET", `/v1/admin/customers?${query}`)).json()).items.map((c) => c.name);
  assert.deepEqual(await ids("q=%25"), ["100% Literal_Name"]);
  assert.deepEqual(await ids("q=_"), ["100% Literal_Name"]);
  assert.deepEqual(await ids("q=literal_NAME"), ["100% Literal_Name"]);
  assert.deepEqual(await ids("q=mixed.case"), ["Customer 1"]);
  assert.equal((await ids("q=%2B91%2098765432")).length, 5);
  assert.deepEqual(await ids("q=987654320"), ["100% Literal_Name"]);
  assert.deepEqual((await ids("state=goa")).sort(), ["100% Literal_Name", "Customer 2", "Customer 4"].sort());
  assert.deepEqual((await ids("source=WEB")).sort(), ["Customer 1", "Customer 3"]);

  for (const query of ["limit=0", "limit=101", "limit=x", "cursor=not-a-cursor", "bogus=1", "q=a&q=b", "limit=1&limit=2"]) {
    await expectError(await f.adminCall("GET", `/v1/admin/customers?${query}`), 400, "INVALID_REQUEST");
  }
});

test("devices see only customers assigned to their current employee, including after reassignment", async (t) => {
  const f = await fixture(t);
  const mine = await f.create({ name: "Mine", phone: "9876543210", employeeIds: [f.alice.id, f.bob.id] });
  const theirs = await f.create({ name: "Theirs", phone: "9876543211", employeeIds: [f.bob.id] });
  const nobody = await f.create({ name: "Nobody", phone: "9876543212" });
  await f.addMessage(mine.id);
  await f.addMessage(theirs.id);
  const aliceGet = (path, method, body) => f.deviceCall(f.aliceDevice, path, method, body);

  const list = await (await aliceGet("/v1/device/customers")).json();
  assert.deepEqual(list.items.map((c) => c.id), [mine.id]);
  assert.deepEqual(list.items[0].employees.map((e) => e.id).sort(), [f.alice.id, f.bob.id].sort());
  assert.equal(list.items[0].messageCount, 1);
  assert.equal((await aliceGet(`/v1/device/customers/${mine.id}`)).status, 200);
  assert.equal((await (await aliceGet(`/v1/device/customers/${mine.id}/messages`)).json()).items.length, 1);
  for (const id of [theirs.id, nobody.id, "cus_unknown"]) {
    await expectError(await aliceGet(`/v1/device/customers/${id}`), 404, "NOT_FOUND");
    await expectError(await aliceGet(`/v1/device/customers/${id}/messages`), 404, "NOT_FOUND");
    await expectError(await aliceGet(`/v1/device/customers/${id}/messages`, "POST", { clientMessageId: crypto.randomUUID(), text: "hi" }), 404, "NOT_FOUND");
  }
  assert.deepEqual((await (await aliceGet("/v1/device/whatsapp/chats")).json()).items.map((c) => c.customer.id), [mine.id]);
  await expectError(await aliceGet("/v1/device/customers?employeeId=x"), 400, "INVALID_REQUEST");

  // Access follows the device's current employee, not the one who enrolled it.
  await f.identity.reassignDevice(f.aliceDevice.device.id, f.bob.id);
  assert.deepEqual((await (await aliceGet("/v1/device/customers")).json()).items.map((c) => c.id).sort(), [mine.id, theirs.id].sort());

  // Archived customers disappear from device access, but anonymous access is never granted.
  await f.adminCall("DELETE", `/v1/admin/customers/${theirs.id}`);
  await expectError(await aliceGet(`/v1/device/customers/${theirs.id}`), 404, "NOT_FOUND");
  assert.equal((await f.request("/v1/device/customers")).status, 401);
  assert.equal((await f.request("/v1/device/customers", { headers: { Authorization: "Bearer ctd_" + "0".repeat(64) } })).status, 401);
});

test("revoked devices and inactive employees lose customer access", async (t) => {
  const f = await fixture(t);
  const customer = await f.create({ name: "Guarded", phone: "9876543210", employeeIds: [f.alice.id, f.bob.id] });
  const paths = ["/v1/device/customers", `/v1/device/customers/${customer.id}`, `/v1/device/customers/${customer.id}/messages`, "/v1/device/whatsapp/chats", "/v1/device/whatsapp/status"];
  for (const path of paths) assert.equal((await f.deviceCall(f.aliceDevice, path)).status, 200, path);
  await f.identity.revokeDevice(f.aliceDevice.device.id);
  await f.identity.setEmployeeActive(f.bob.id, false);
  for (const path of paths) {
    await expectError(await f.deviceCall(f.aliceDevice, path), 401, "UNAUTHORIZED");
    await expectError(await f.deviceCall(f.bobDevice, path), 401, "UNAUTHORIZED");
  }
  await expectError(await f.deviceCall(f.aliceDevice, `/v1/device/customers/${customer.id}/messages`, "POST", { clientMessageId: crypto.randomUUID(), text: "hi" }), 401, "UNAUTHORIZED");
});

test("messages paginate newest first across tied timestamps and render text literally", async (t) => {
  const f = await fixture(t);
  const customer = await f.create({ name: "Chatty", phone: "9876543210", employeeIds: [f.alice.id] });
  const tied = "2026-09-24T09:00:00.000Z";
  const hostile = "<img src=x onerror=alert(1)> \u202e %_ ";
  const expected = [];
  for (let index = 0; index < 5; index += 1) expected.push(await f.addMessage(customer.id, { sentAt: tied, body: index === 0 ? hostile : undefined }));
  expected.push(await f.addMessage(customer.id, { sentAt: "2026-09-24T09:00:01.000Z", direction: "out" }));
  await f.DB.prepare("UPDATE whatsapp_messages SET sent_by_employee_id = ?, media_url = 'javascript:alert(1)' WHERE id = ?").bind(f.alice.id, expected[5]).run();
  await f.DB.prepare("UPDATE whatsapp_messages SET media_url = 'https://files.example.test/a.jpg', message_type = 'image' WHERE id = ?").bind(expected[1]).run();

  for (const fetchPage of [
    (query) => f.adminCall("GET", `/v1/admin/customers/${customer.id}/messages${query}`),
    (query) => f.deviceCall(f.aliceDevice, `/v1/device/customers/${customer.id}/messages${query}`),
  ]) {
    const seen = [];
    let query = "?limit=2";
    for (let pages = 0; pages < 6 && query; pages += 1) {
      const page = await (await fetchPage(query)).json();
      seen.push(...page.items);
      query = page.nextCursor ? `?limit=2&cursor=${page.nextCursor}` : null;
    }
    assert.deepEqual(seen.map((m) => m.id), [expected[5], ...expected.slice(0, 5).reverse()]);
    assert.deepEqual(seen[0].sentBy, { id: f.alice.id, name: f.alice.name });
    assert.equal(seen[0].direction, "out");
    assert.equal("mediaUrl" in seen[0], false);
    assert.equal(seen.find((m) => m.id === expected[1]).mediaUrl, "https://files.example.test/a.jpg");
    assert.equal(seen.at(-1).body, hostile);
    assert.equal(seen.at(-1).customerId, customer.id);
  }
});

test("chat summaries list only customers with messages, newest conversation first, with trimmed text", async (t) => {
  const f = await fixture(t);
  const older = await f.create({ name: "Older chat", phone: "9876543210", employeeIds: [f.alice.id] });
  const newer = await f.create({ name: "Newer chat", phone: "9876543211", employeeIds: [f.alice.id, f.bob.id] });
  const silent = await f.create({ name: "No chat", phone: "9876543212", employeeIds: [f.alice.id] });
  const other = await f.create({ name: "Bobs chat", phone: "9876543213", employeeIds: [f.bob.id] });
  await f.addMessage(older.id, { sentAt: "2026-09-24T08:00:00.000Z" });
  await f.addMessage(newer.id, { sentAt: "2026-09-24T08:30:00.000Z" });
  await f.addMessage(newer.id, { sentAt: "2026-09-24T09:30:00.000Z", direction: "out", body: "x".repeat(500) });
  await f.addMessage(other.id, { sentAt: "2026-09-24T09:00:00.000Z" });
  await f.DB.prepare("UPDATE whatsapp_messages SET body = NULL, message_type = 'image' WHERE customer_id = ?").bind(older.id).run();

  const admin = await (await f.adminCall("GET", "/v1/admin/whatsapp/chats")).json();
  assert.deepEqual(admin.items.map((c) => c.customer.id), [newer.id, other.id, older.id]);
  assert.ok(!admin.items.some((c) => c.customer.id === silent.id));
  assert.equal(admin.items[0].messageCount, 2);
  assert.equal(admin.items[0].lastMessage.text, "x".repeat(200));
  assert.equal(admin.items[0].lastMessage.direction, "out");
  assert.deepEqual(admin.items[0].customer, { id: newer.id, name: "Newer chat", phone: "+919876543211" });
  assert.equal(admin.items[2].lastMessage.text, "");
  assert.equal(admin.items[2].lastMessage.messageType, "image");

  assert.deepEqual((await (await f.adminCall("GET", `/v1/admin/whatsapp/chats?employeeId=${f.bob.id}`)).json()).items.map((c) => c.customer.id), [newer.id, other.id]);
  assert.deepEqual((await (await f.adminCall("GET", "/v1/admin/whatsapp/chats?q=older")).json()).items.map((c) => c.customer.id), [older.id]);
  const page = await (await f.adminCall("GET", "/v1/admin/whatsapp/chats?limit=1")).json();
  assert.equal(page.items.length, 1);
  const next = await (await f.adminCall("GET", `/v1/admin/whatsapp/chats?limit=1&cursor=${page.nextCursor}`)).json();
  assert.deepEqual(next.items.map((c) => c.customer.id), [other.id]);
  const deviceChats = await (await f.deviceCall(f.aliceDevice, "/v1/device/whatsapp/chats")).json();
  assert.deepEqual(deviceChats.items.map((c) => c.customer.id), [newer.id, older.id]);
  assert.deepEqual(deviceChats.items[0].employees.map((e) => e.id).sort(), [f.alice.id, f.bob.id].sort());
});

test("customer calls match by last ten digits across formats and employees, excluding deleted logs", async (t) => {
  const f = await fixture(t);
  const customer = await f.create({ name: "Caller", phone: "9876543210", employeeIds: [f.alice.id] });
  const accepted = (await (await f.logCalls(f.aliceDevice, [
    logEntry(1, { remoteNumber: "+91 98765-43210" }),
    logEntry(2, { remoteNumber: "09876543210" }),
    logEntry(3, { remoteNumber: "(987) 654 3210" }),
    logEntry(4, { remoteNumber: "9876543211" }),
    logEntry(5, { remoteNumber: "543210" }),
    logEntry(6, { remoteNumber: "987654321A" }),
    logEntry(7),
    logEntry(8, { remoteNumber: "0091 98765 43210" }),
  ])).json()).accepted;
  const byIndex = (index) => accepted[index - 1].id;
  const bobAccepted = (await (await f.logCalls(f.bobDevice, [logEntry(1, { remoteNumber: "+919876543210", callType: "outgoing" })])).json()).accepted[0];

  // A recording linked to one matching call rides along in the unified-feed representation.
  const pending = await createCallRepository(f.DB, () => new Date(start)).createPending({
    deviceId: f.aliceDevice.device.id, fingerprint: "a".repeat(64), displayName: "synthetic.m4a",
    contentType: "audio/mp4", expectedBytes: 4, recordedAt: "2026-09-24T11:00:01.500Z",
    durationSeconds: 20, matchStatus: "media_metadata",
  });
  await createCallRepository(f.DB, () => new Date(start)).complete(pending.id, pending.deviceId, { actualBytes: 4 });

  const fetchCalls = async (query = "") => (await f.adminCall("GET", `/v1/admin/customers/${customer.id}/calls${query}`)).json();
  const page = await fetchCalls();
  const got = new Set(page.items.map((c) => c.id));
  assert.deepEqual(got, new Set([byIndex(1), byIndex(2), byIndex(3), byIndex(8), bobAccepted.id]));
  const times = page.items.map((c) => c.startedAt);
  assert.deepEqual(times, [...times].sort().reverse());
  assert.ok(page.items.every((c) => c.kind === "call"));
  assert.deepEqual(new Set(page.items.map((c) => c.employee.id)), new Set([f.alice.id, f.bob.id]));
  const linked = page.items.find((c) => c.id === byIndex(1));
  assert.equal(linked.recordings.length, 1);
  assert.equal(linked.recordings[0].id, pending.id);
  assert.equal(linked.recordings[0].employee.id, f.alice.id);
  assert.equal(linked.callType, "incoming");
  assert.equal(linked.durationSeconds, 20);

  const summary = (await (await f.adminCall("GET", `/v1/admin/customers/${customer.id}`)).json()).customer;
  assert.equal(summary.lastCallAt, "2026-09-24T11:00:08.000Z");

  // Deleting a call log removes it from customer calls and from lastCallAt.
  await f.adminCall("DELETE", `/v1/admin/call-logs/${byIndex(8)}`);
  const afterDelete = await fetchCalls();
  assert.equal(afterDelete.items.length, 4);
  assert.ok(!afterDelete.items.some((c) => c.id === byIndex(8)));
  assert.equal((await (await f.adminCall("GET", `/v1/admin/customers/${customer.id}`)).json()).customer.lastCallAt, "2026-09-24T11:00:03.000Z");

  // Pagination keeps every matching call exactly once.
  const first = await fetchCalls("?limit=3");
  assert.equal(first.items.length, 3);
  assert.ok(first.nextCursor);
  const second = await fetchCalls(`?limit=3&cursor=${first.nextCursor}`);
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(new Set([...first.items, ...second.items].map((c) => c.id)), new Set(afterDelete.items.map((c) => c.id)));

  // A short number never matches calls, and unknown customers are 404.
  const short = await f.create({ name: "Short", phone: "54321098" });
  const shortCalls = await (await f.adminCall("GET", `/v1/admin/customers/${short.id}/calls`)).json();
  assert.deepEqual(shortCalls.items, []);
  await expectError(await f.adminCall("GET", "/v1/admin/customers/cus_unknown/calls"), 404, "NOT_FOUND");
  // Devices have no customer-calls route.
  assert.equal((await f.deviceCall(f.aliceDevice, `/v1/device/customers/${customer.id}/calls`)).status, 404);
});

test("sending validates the body and assignment, then reports WhatsApp as unconfigured without storing anything", async (t) => {
  const f = await fixture(t);
  const customer = await f.create({ name: "Recipient", phone: "9876543210", employeeIds: [f.alice.id] });
  const send = (body, device = f.aliceDevice, id = customer.id) =>
    f.deviceCall(device, `/v1/device/customers/${id}/messages`, "POST", body);
  const counts = async () => (await f.DB.prepare("SELECT count(*) AS n FROM whatsapp_messages").first()).n;

  const status = await (await f.deviceCall(f.aliceDevice, "/v1/device/whatsapp/status")).json();
  assert.equal(status.canSend, false);
  assert.equal(status.requestId.length > 0, true);

  const valid = { clientMessageId: crypto.randomUUID(), text: "hello" };
  const refused = await expectError(await send(valid), 503, "WHATSAPP_NOT_CONFIGURED");
  assert.equal(refused.error.message.length > 0, true);
  await expectError(await send({ ...valid, text: "x".repeat(4096) }), 503, "WHATSAPP_NOT_CONFIGURED");
  for (const body of [
    {}, { text: "hello" }, { clientMessageId: "not-a-uuid", text: "hello" },
    { ...valid, text: "" }, { ...valid, text: "x".repeat(4097) }, { ...valid, extra: true },
  ]) await expectError(await send(body), 400, "INVALID_REQUEST");
  await expectError(await send(valid, f.bobDevice), 404, "NOT_FOUND");
  assert.equal(await counts(), 0);
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM customers").first()).n, 1);
});
