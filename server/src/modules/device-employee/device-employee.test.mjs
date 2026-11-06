import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase, enableFeatures, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { createIdentityRepository } = await loadModule("./identity.ts");
const adminSecret = "synthetic-employee-admin-secret-not-for-deployment";
const tokenSecret = "synthetic-employee-token-secret-not-for-deployment";
const start = "2026-10-18T12:00:00.000Z";
const admin = { Authorization: `Bearer ${adminSecret}` };

async function fixture(t) {
  const DB = await createDatabase(t);
  await enableFeatures(DB);
  const identity = createIdentityRepository(DB, tokenSecret, () => new Date(start));
  const people = {};
  for (const name of ["Alice", "Bob"]) {
    const employee = await identity.createEmployee({ name: `${name} Synthetic` });
    const invitation = await identity.createInvitation(employee.id, "2026-10-19T00:00:00Z");
    people[name.toLowerCase()] = {
      employee, enrolled: await identity.redeemInvitation(invitation.invitationCode, { model: "Synthetic device" }),
    };
  }
  const env = { DB, TOKEN_HASH_SECRET: tokenSecret, LOCAL_ADMIN_SECRET: adminSecret, ENVIRONMENT: "development" };
  const app = createApp();
  const call = (who, path, method = "GET", body) => app.request(new URL(path, "http://127.0.0.1"), {
    method,
    headers: {
      Authorization: `Bearer ${people[who].enrolled.deviceToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  const adminCall = (path, method = "GET", body) => app.request(new URL(path, "http://127.0.0.1"), {
    method,
    headers: { ...admin, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  let sequence = 0;
  const addLog = async (who, startedAt, durationSeconds, callType, remoteNumber) => {
    sequence += 1;
    const id = `log_${sequence}`;
    await DB.prepare(
      `INSERT INTO call_logs (id, device_id, employee_id, fingerprint, started_at, duration_seconds, call_type, remote_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, people[who].enrolled.device.id, people[who].employee.id, sequence.toString(16).padStart(64, "0"),
      startedAt, durationSeconds, callType, remoteNumber ?? null, start).run();
    return id;
  };
  const addRecording = async (who, logId, status = "complete") => {
    sequence += 1;
    const id = `rec_${sequence}`;
    await DB.prepare(
      `INSERT INTO calls (id, employee_id, device_id, fingerprint, display_name, match_status, object_key,
         content_type, expected_bytes, upload_status, created_at, call_log_id)
       VALUES (?, ?, ?, ?, 'secret-recording.m4a', 'call_log', ?, 'audio/mp4', 10, ?, ?, ?)`,
    ).bind(id, people[who].employee.id, people[who].enrolled.device.id, `rec-fp-${sequence}`,
      `https://example.invalid/secret-${sequence}.m4a`, status, start, logId).run();
    await DB.prepare("UPDATE calls SET call_log_id = ? WHERE id = ?").bind(logId, id).run();
  };
  return { DB, people, call, adminCall, addLog, addRecording };
}

test("device analytics equal the admin report filtered to the caller and never include other employees", async (t) => {
  const f = await fixture(t);
  await f.addLog("alice", "2026-10-12T04:00:00.000Z", 120, "outgoing", "+919800000001");
  await f.addLog("alice", "2026-10-13T04:00:00.000Z", 0, "missed", "+919800000002");
  await f.addLog("bob", "2026-10-12T05:00:00.000Z", 700, "outgoing", "+919800000003");
  const query = "?from=2026-10-12&to=2026-10-18";
  const mine = await f.call("alice", `/v1/device/analytics${query}`);
  assert.equal(mine.status, 200);
  const body = await mine.json();
  const expected = await (await f.adminCall(
    `/v1/admin/analytics/calls${query}&employeeIds=${f.people.alice.employee.id}`)).json();
  const { requestId: _a, ...device } = body;
  const { requestId: _b, ...reference } = expected;
  assert.deepEqual(device, reference);
  assert.equal(body.totals.total, 2);
  assert.deepEqual(body.employees.map((employee) => employee.id), [f.people.alice.employee.id]);
  assert.ok(!JSON.stringify(body).includes("Bob"));
  const bobs = await (await f.call("bob", `/v1/device/analytics${query}`)).json();
  assert.equal(bobs.totals.total, 1);
  assert.equal(bobs.totals.talkSeconds, 700);
});

test("device analytics refuse an employee filter, bad dates and unauthenticated callers, and honour call types", async (t) => {
  const f = await fixture(t);
  await f.addLog("alice", "2026-10-12T04:00:00.000Z", 120, "outgoing", "+919800000001");
  await f.addLog("alice", "2026-10-13T04:00:00.000Z", 0, "missed", "+919800000002");
  const forged = await f.call("alice", `/v1/device/analytics?employeeIds=${f.people.bob.employee.id}`);
  assert.equal(forged.status, 400);
  assert.equal((await f.call("alice", "/v1/device/analytics?from=2026-10-18&to=2026-10-12")).status, 400);
  assert.equal((await f.call("alice", "/v1/device/analytics?from=nope")).status, 400);
  const anonymous = await createApp().request("http://127.0.0.1/v1/device/analytics", {},
    { DB: f.DB, TOKEN_HASH_SECRET: tokenSecret, ENVIRONMENT: "development" });
  assert.equal(anonymous.status, 401);
  const typed = await (await f.call("alice", "/v1/device/analytics?from=2026-10-12&to=2026-10-18&callTypes=missed")).json();
  assert.equal(typed.totals.total, 1);
  const defaults = await (await f.call("alice", "/v1/device/analytics")).json();
  assert.equal(defaults.range.days, 7);
});

test("device call history lists only the caller's calls with hasRecording and no playback data", async (t) => {
  const f = await fixture(t);
  const withAudio = await f.addLog("alice", "2026-10-12T04:00:00.000Z", 120, "outgoing", "+919800000001");
  await f.addRecording("alice", withAudio);
  const pending = await f.addLog("alice", "2026-10-12T05:00:00.000Z", 20, "incoming", "+919800000002");
  await f.addRecording("alice", pending, "pending");
  await f.addLog("alice", "2026-10-12T06:00:00.000Z", 0, "missed", "+919800000003");
  const deleted = await f.addLog("alice", "2026-10-12T07:00:00.000Z", 5, "incoming", "+919800000004");
  await f.DB.prepare("UPDATE call_logs SET deleted_at = ? WHERE id = ?").bind(start, deleted).run();
  const bobLog = await f.addLog("bob", "2026-10-12T08:00:00.000Z", 50, "incoming", "+919800000005");
  await f.addRecording("bob", bobLog);
  const response = await f.call("alice", "/v1/device/call-history");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.items.length, 3);
  assert.deepEqual(body.items.map((item) => item.hasRecording), [false, false, true]);
  assert.ok(body.items.every((item) => item.employee.id === f.people.alice.employee.id && item.kind === "call"));
  assert.equal(body.nextCursor, null);
  const text = JSON.stringify(body);
  assert.ok(!text.includes("secret"));
  assert.ok(!text.includes("recordings"));
  assert.ok(!text.includes(bobLog));
  const recorded = await (await f.call("alice", "/v1/device/call-history?hasRecording=true")).json();
  assert.deepEqual(recorded.items.map((item) => item.id), [withAudio]);
  // Another employee's id in the query is refused, not honoured.
  assert.equal((await f.call("alice", `/v1/device/call-history?employeeId=${f.people.bob.employee.id}`)).status, 400);
  const bobs = await (await f.call("bob", "/v1/device/call-history")).json();
  assert.deepEqual(bobs.items.map((item) => item.id), [bobLog]);
});

test("device call history paginates newest first and filters like the admin feed", async (t) => {
  const f = await fixture(t);
  const ids = [];
  for (let minute = 0; minute < 5; minute += 1) {
    ids.push(await f.addLog("alice", `2026-10-12T04:0${minute}:00.000Z`, minute, minute % 2 ? "incoming" : "outgoing",
      minute === 4 ? "+919800000009" : "+919800000001"));
  }
  const seen = [];
  let cursor = "";
  for (let page = 0; page < 3; page += 1) {
    const body = await (await f.call("alice", `/v1/device/call-history?limit=2${cursor}`)).json();
    seen.push(...body.items.map((item) => item.id));
    if (!body.nextCursor) break;
    cursor = `&cursor=${body.nextCursor}`;
  }
  assert.deepEqual(seen, [...ids].reverse());
  const typed = await (await f.call("alice", "/v1/device/call-history?callType=incoming")).json();
  assert.deepEqual(typed.items.map((item) => item.id), [ids[3], ids[1]]);
  const numbered = await (await f.call("alice", "/v1/device/call-history?number=0009")).json();
  assert.deepEqual(numbered.items.map((item) => item.id), [ids[4]]);
  const ranged = await (await f.call("alice",
    "/v1/device/call-history?from=2026-10-12T04:01:00.000Z&to=2026-10-12T04:03:00.000Z")).json();
  assert.deepEqual(ranged.items.map((item) => item.id), [ids[3], ids[2], ids[1]]);
  assert.equal((await f.call("alice", "/v1/device/call-history?from=2026-10-13T00:00:00Z&to=2026-10-12T00:00:00Z")).status, 400);
  assert.equal((await f.call("alice", "/v1/device/call-history?cursor=garbage!")).status, 400);
  assert.equal((await f.call("alice", "/v1/device/call-history?limit=101")).status, 400);
  // A cursor from the owner cannot be used to reach someone else's calls.
  const bobFirst = await f.call("bob", "/v1/device/call-history?limit=1");
  assert.deepEqual((await bobFirst.json()).items, []);
});

test("call history names only the caller's own customers", async (t) => {
  const f = await fixture(t);
  await f.addLog("alice", "2026-10-12T04:00:00.000Z", 10, "incoming", "+919800000001");
  await f.addLog("alice", "2026-10-12T05:00:00.000Z", 10, "incoming", "+919800000002");
  const mine = await f.adminCall("/v1/admin/customers", "POST",
    { name: "Mine Synthetic", phone: "+919800000001", employeeIds: [f.people.alice.employee.id] });
  const theirs = await f.adminCall("/v1/admin/customers", "POST",
    { name: "Theirs Synthetic", phone: "+919800000002", employeeIds: [f.people.bob.employee.id] });
  assert.equal(mine.status, 201);
  assert.equal(theirs.status, 201);
  const body = await (await f.call("alice", "/v1/device/call-history")).json();
  assert.equal(body.items[1].customer.name, "Mine Synthetic");
  assert.equal(body.items[0].customer, undefined);
  assert.ok(!JSON.stringify(body).includes("Theirs"));
});

test("lookup reports existence without leaking other employees' customers", async (t) => {
  const f = await fixture(t);
  await f.adminCall("/v1/admin/customers", "POST", { name: "Mine Synthetic", phone: "+919800000001", employeeIds: [f.people.alice.employee.id] });
  await f.adminCall("/v1/admin/customers", "POST", { name: "Secret Other Synthetic", phone: "+919800000002", employeeIds: [f.people.bob.employee.id] });
  await f.adminCall("/v1/admin/customers", "POST", { name: "Unassigned Synthetic", phone: "+919800000003" });
  const lookup = async (who, phone) => {
    const response = await f.call(who, `/v1/device/customers/lookup?phone=${encodeURIComponent(phone)}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const own = await lookup("alice", "9800000001");
  assert.deepEqual({ ...own, requestId: undefined }, {
    requestId: undefined, phone: "+919800000001", exists: true, mine: true,
    customer: { id: own.customer.id, name: "Mine Synthetic" },
  });
  const other = await lookup("alice", "+91 98000 00002");
  assert.deepEqual({ ...other, requestId: undefined }, { requestId: undefined, phone: "+919800000002", exists: true, mine: false });
  assert.ok(!JSON.stringify(other).includes("Secret"));
  const unassigned = await lookup("alice", "09800000003");
  assert.equal(unassigned.exists, true);
  assert.equal(unassigned.mine, false);
  assert.equal(unassigned.customer, undefined);
  const missing = await lookup("alice", "9800000099");
  assert.deepEqual({ ...missing, requestId: undefined }, { requestId: undefined, phone: "+919800000099", exists: false, mine: false });
  assert.equal((await f.call("alice", "/v1/device/customers/lookup")).status, 400);
  assert.equal((await f.call("alice", "/v1/device/customers/lookup?phone=abc")).status, 400);
  assert.equal((await f.call("alice", "/v1/device/customers/lookup?phone=9800000001&x=1")).status, 400);
  // Archived customers free the number.
  await f.adminCall(`/v1/admin/customers/${own.customer.id}`, "DELETE");
  assert.equal((await lookup("alice", "9800000001")).exists, false);
});

test("an employee creates a customer assigned to them alone, visible to the admin as an App customer", async (t) => {
  const f = await fixture(t);
  const response = await f.call("alice", "/v1/device/customers", "POST", { name: " New Synthetic ", phone: "98000 00010", notes: "Called back" });
  assert.equal(response.status, 201);
  const { customer } = await response.json();
  assert.equal(customer.name, "New Synthetic");
  assert.equal(customer.phone, "+919800000010");
  assert.equal(customer.notes, "Called back");
  assert.equal(customer.source, "App");
  assert.deepEqual(customer.employees, [{ id: f.people.alice.employee.id, name: "Alice Synthetic" }]);
  assert.deepEqual(customer.createdBy, { id: f.people.alice.employee.id, name: "Alice Synthetic" });
  const listed = await (await f.call("alice", "/v1/device/customers")).json();
  assert.deepEqual(listed.items.map((item) => item.id), [customer.id]);
  assert.equal((await f.call("bob", `/v1/device/customers/${customer.id}`)).status, 404);
  assert.deepEqual((await (await f.call("bob", "/v1/device/customers")).json()).items, []);
  const adminView = await (await f.adminCall(`/v1/admin/customers/${customer.id}`)).json();
  assert.equal(adminView.customer.source, "App");
  assert.equal(adminView.customer.createdBy.name, "Alice Synthetic");
  const bySource = await (await f.adminCall("/v1/admin/customers?source=App")).json();
  assert.deepEqual(bySource.items.map((item) => item.id), [customer.id]);
  // Administrators' own customers carry no created-by.
  const adminMade = await (await f.adminCall("/v1/admin/customers", "POST", { name: "Admin Synthetic", phone: "+919800000011" })).json();
  assert.equal(adminMade.customer.createdBy, undefined);
});

test("creating a customer validates input and answers duplicates with 409 customer_exists", async (t) => {
  const f = await fixture(t);
  await f.adminCall("/v1/admin/customers", "POST", { name: "Other Synthetic", phone: "+919800000002", employeeIds: [f.people.bob.employee.id] });
  const first = await (await f.call("alice", "/v1/device/customers", "POST", { name: "Mine", phone: "+919800000001" })).json();

  const own = await f.call("alice", "/v1/device/customers", "POST", { name: "Again", phone: "9800000001" });
  assert.equal(own.status, 409);
  const ownBody = await own.json();
  assert.equal(ownBody.error.code, "customer_exists");
  assert.equal(ownBody.error.customerId, first.customer.id);

  const others = await f.call("alice", "/v1/device/customers", "POST", { name: "Steal", phone: "+91 9800000002" });
  assert.equal(others.status, 409);
  const othersText = await others.text();
  assert.equal(JSON.parse(othersText).error.code, "customer_exists");
  assert.ok(!othersText.includes("customerId"));
  assert.ok(!othersText.includes("Other Synthetic"));
  // The other customer was not touched.
  assert.deepEqual((await (await f.call("alice", "/v1/device/customers")).json()).items.map((item) => item.id), [first.customer.id]);

  for (const body of [
    { name: "No phone" }, { phone: "+919800000020" }, { name: "", phone: "+919800000020" },
    { name: "Bad", phone: "12" }, { name: "Extra", phone: "+919800000020", source: "Hacked" },
    { name: "Extra", phone: "+919800000020", employeeIds: [f.people.bob.employee.id] },
  ]) {
    assert.equal((await f.call("alice", "/v1/device/customers", "POST", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await createApp().request("http://127.0.0.1/v1/device/customers", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }, { DB: f.DB, TOKEN_HASH_SECRET: tokenSecret, ENVIRONMENT: "development" })).status, 401);
});

test("an employee edits name and notes of their own customers but not the phone", async (t) => {
  const f = await fixture(t);
  const mine = (await (await f.call("alice", "/v1/device/customers", "POST", { name: "Mine", phone: "+919800000001", notes: "old" })).json()).customer;
  const theirs = (await (await f.adminCall("/v1/admin/customers", "POST", { name: "Theirs", phone: "+919800000002", employeeIds: [f.people.bob.employee.id] })).json()).customer;
  const loose = (await (await f.adminCall("/v1/admin/customers", "POST", { name: "Loose", phone: "+919800000003" })).json()).customer;

  const patched = await f.call("alice", `/v1/device/customers/${mine.id}`, "PATCH", { name: "Renamed", notes: "new notes" });
  assert.equal(patched.status, 200);
  const body = (await patched.json()).customer;
  assert.equal(body.name, "Renamed");
  assert.equal(body.notes, "new notes");
  assert.equal(body.phone, "+919800000001");
  assert.equal(body.source, "App");
  const notesOnly = (await (await f.call("alice", `/v1/device/customers/${mine.id}`, "PATCH", { notes: null })).json()).customer;
  assert.equal(notesOnly.name, "Renamed");
  assert.equal(notesOnly.notes, undefined);

  // The stored number may be echoed back, in any format; anything else is refused and changes nothing.
  assert.equal((await f.call("alice", `/v1/device/customers/${mine.id}`, "PATCH", { name: "Echo", phone: "9800000001" })).status, 200);
  const changed = await f.call("alice", `/v1/device/customers/${mine.id}`, "PATCH", { name: "Hijack", phone: "+919800000099" });
  assert.equal(changed.status, 400);
  assert.equal((await changed.json()).error.code, "phone_not_editable");
  const garbage = await f.call("alice", `/v1/device/customers/${mine.id}`, "PATCH", { phone: "abc" });
  assert.equal(garbage.status, 400);
  assert.equal((await garbage.json()).error.code, "phone_not_editable");
  const after = (await (await f.call("alice", `/v1/device/customers/${mine.id}`)).json()).customer;
  assert.equal(after.name, "Echo");
  assert.equal(after.phone, "+919800000001");

  for (const id of [theirs.id, loose.id, "cus_missing"]) {
    assert.equal((await f.call("alice", `/v1/device/customers/${id}`, "PATCH", { name: "Nope" })).status, 404);
    // Even a wrong phone does not reveal that the customer exists.
    assert.equal((await f.call("alice", `/v1/device/customers/${id}`, "PATCH", { phone: "+919800000099" })).status, 404);
  }
  assert.equal((await (await f.adminCall(`/v1/admin/customers/${theirs.id}`)).json()).customer.name, "Theirs");
  assert.equal((await (await f.adminCall(`/v1/admin/customers/${loose.id}`)).json()).customer.name, "Loose");
  for (const bad of [{}, { name: "" }, { email: "x@example.invalid" }, { notes: "x".repeat(4001) }, { source: "Hack" }]) {
    assert.equal((await f.call("alice", `/v1/device/customers/${mine.id}`, "PATCH", bad)).status, 400, JSON.stringify(bad));
  }
});

test("customer routes stay behind the customers feature flag", async (t) => {
  const f = await fixture(t);
  await f.DB.prepare("DELETE FROM app_settings WHERE key = 'feature.customers'").run();
  await f.DB.prepare("INSERT INTO app_settings (key, value, encrypted, updated_at) VALUES ('feature.customers', 'false', 0, '2026-01-01T00:00:00.000Z')").run();
  assert.equal((await f.call("alice", "/v1/device/customers/lookup?phone=9800000001")).status, 404);
  assert.equal((await f.call("alice", "/v1/device/customers", "POST", { name: "N", phone: "+919800000001" })).status, 404);
  // Analytics and call history are not gated.
  assert.equal((await f.call("alice", "/v1/device/analytics")).status, 200);
  assert.equal((await f.call("alice", "/v1/device/call-history")).status, 200);
});

test("profile returns only the caller's own name and configured contact number", async (t) => {
  const f = await fixture(t);
  await f.adminCall(`/v1/admin/employees/${f.people.alice.employee.id}`, "PATCH", { phoneNumber: "98000 00077" });
  const alice = await f.call("alice", "/v1/device/profile");
  assert.equal(alice.status, 200);
  const body = await alice.json();
  assert.deepEqual(body.employee, { id: f.people.alice.employee.id, name: "Alice Synthetic", phoneNumber: "+919800000077" });
  const bob = await (await f.call("bob", "/v1/device/profile")).json();
  assert.deepEqual(bob.employee, { id: f.people.bob.employee.id, name: "Bob Synthetic", phoneNumber: null });
  assert.ok(!JSON.stringify(bob).includes("Alice"));
  const anonymous = await createApp().request("http://127.0.0.1/v1/device/profile", {},
    { DB: f.DB, TOKEN_HASH_SECRET: tokenSecret, ENVIRONMENT: "development" });
  assert.equal(anonymous.status, 401);
});
