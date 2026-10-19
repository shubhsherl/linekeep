import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { createAnalyticsTestApp } = await loadModule("../modules/analytics/test-app.ts");
const { createIdentityRepository } = await loadModule("./identity.ts");
const adminSecret = "synthetic-analytics-admin-secret-not-for-deployment";
const tokenSecret = "synthetic-analytics-token-secret-not-for-deployment";
const start = "2026-10-18T12:00:00.000Z";
const admin = { Authorization: `Bearer ${adminSecret}` };
const types = [
  "incoming", "outgoing", "missed", "rejected", "blocked", "voicemail",
  "answered_externally", "unknown",
];
const numbers = {
  N1: "+919800000001", N2: "+919800000002", N3: "+919800000003",
  N4: "+919800000004", N5: "+919800000005", N6: "+919800000006",
};

async function fixture(t) {
  const DB = await createDatabase(t);
  const identity = createIdentityRepository(DB, tokenSecret, () => new Date(start));
  const people = {};
  for (const name of ["Alice Synthetic", "Bob Synthetic", "Aaron Synthetic"]) {
    const employee = await identity.createEmployee({ name });
    const invitation = await identity.createInvitation(employee.id, "2026-10-19T00:00:00Z");
    const enrolled = await identity.redeemInvitation(invitation.invitationCode, { model: "Synthetic device" });
    people[name.split(" ")[0].toLowerCase()] = { employee, deviceId: enrolled.device.id };
  }
  const env = { DB, TOKEN_HASH_SECRET: tokenSecret, LOCAL_ADMIN_SECRET: adminSecret, ENVIRONMENT: "development" };
  const app = createApp();
  const get = (query = "", headers = admin) =>
    app.request(new URL(`/v1/admin/analytics/calls${query}`, "http://127.0.0.1"), { headers }, env);
  let sequence = 0;
  const addLog = async (who, startedAt, durationSeconds, callType, remoteNumber) => {
    sequence += 1;
    const id = `log_${sequence}`;
    await DB.prepare(
      `INSERT INTO call_logs (id, device_id, employee_id, fingerprint, started_at, duration_seconds, call_type, remote_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, people[who].deviceId, people[who].employee.id, sequence.toString(16).padStart(64, "0"),
      startedAt, durationSeconds, callType, remoteNumber ?? null, start).run();
    return id;
  };
  const addRecording = async (who, logId, extra = {}) => {
    sequence += 1;
    await DB.prepare(
      `INSERT INTO calls (id, employee_id, device_id, fingerprint, display_name, match_status, object_key,
         content_type, expected_bytes, upload_status, created_at, deleted_at, call_log_id)
       VALUES (?, ?, ?, ?, 'secret-recording.m4a', 'call_log', ?, 'audio/mp4', 10, ?, ?, ?, ?)`,
    ).bind(`rec_${sequence}`, people[who].employee.id, people[who].deviceId, `rec-fp-${sequence}`,
      `https://example.invalid/secret-${sequence}.m4a`, extra.status ?? "complete", start, extra.deletedAt ?? null, logId).run();
    // The insert trigger recomputes the link from metadata; set the explicit link afterwards.
    await DB.prepare("UPDATE calls SET call_log_id = ? WHERE id = ?").bind(logId, `rec_${sequence}`).run();
  };
  return { DB, people, app, env, get, addLog, addRecording };
}

async function seed(f) {
  const { addLog, addRecording } = f;
  // Current window 2026-10-12..2026-10-18 (IST). 10-18 is a Sunday.
  await addLog("alice", "2026-10-11T18:30:00.000Z", 10, "incoming", numbers.N2); // IST 10-12 00:00 Mon
  const a1 = await addLog("alice", "2026-10-12T04:00:00.000Z", 120, "outgoing", numbers.N1); // Mon 09
  const a2 = await addLog("alice", "2026-10-12T04:10:00.000Z", 30, "incoming", numbers.N1);
  await addLog("alice", "2026-10-13T20:00:00.000Z", 0, "missed", numbers.N2); // IST Wed 10-14 01
  const b1 = await addLog("bob", "2026-10-14T05:00:00.000Z", 700, "outgoing", numbers.N1); // Wed 10
  await addLog("bob", "2026-10-14T05:05:00.000Z", 0, "rejected");
  const b3 = await addLog("bob", "2026-10-14T05:10:00.000Z", 45, "voicemail", numbers.N3);
  await addLog("bob", "2026-10-18T18:29:59.999Z", 59, "answered_externally", numbers.N4); // Sun 23:59:59 IST
  await addLog("bob", "2026-10-18T18:30:00.000Z", 0, "blocked", numbers.N5); // IST 10-19: outside
  await addLog("aaron", "2026-10-15T10:00:00.000Z", 90, "outgoing", numbers.N6); // Thu 15
  const deleted = await addLog("alice", "2026-10-15T05:00:00.000Z", 300, "outgoing", numbers.N5);
  await f.DB.prepare("UPDATE call_logs SET deleted_at = ? WHERE id = ?").bind(start, deleted).run();
  // Previous window 2026-10-05..2026-10-11.
  await addLog("alice", "2026-10-06T05:00:00.000Z", 60, "outgoing", numbers.N1);
  await addLog("bob", "2026-10-11T18:29:59.999Z", 200, "incoming", numbers.N2);
  await addLog("alice", "2026-10-04T18:29:59.999Z", 50, "incoming", numbers.N1); // before previous window
  // Recordings: only a completed, non-deleted one counts, once per call.
  await addRecording("alice", a1);
  await addRecording("alice", a1);
  await addRecording("alice", a2, { status: "pending" });
  await addRecording("bob", b1, { status: "deleted", deletedAt: start });
  await addRecording("bob", b3, { deletedAt: start });
}

const range = "from=2026-10-12&to=2026-10-18";
const aliceMetrics = {
  total: 4, connected: 3, notConnected: 1, uniqueContacts: 2, talkSeconds: 160, avgConnectedSeconds: 53,
  incoming: 2, incomingSeconds: 40, outgoing: 1, outgoingSeconds: 120, missed: 1, rejected: 0, other: 0,
  withRecording: 1,
};
const bobMetrics = {
  total: 4, connected: 3, notConnected: 1, uniqueContacts: 3, talkSeconds: 804, avgConnectedSeconds: 268,
  incoming: 0, incomingSeconds: 0, outgoing: 1, outgoingSeconds: 700, missed: 0, rejected: 1, other: 2,
  withRecording: 0,
};
const aaronMetrics = {
  total: 1, connected: 1, notConnected: 0, uniqueContacts: 1, talkSeconds: 90, avgConnectedSeconds: 90,
  incoming: 0, incomingSeconds: 0, outgoing: 1, outgoingSeconds: 90, missed: 0, rejected: 0, other: 0,
  withRecording: 0,
};
const zeroMetrics = {
  total: 0, connected: 0, notConnected: 0, uniqueContacts: 0, talkSeconds: 0, avgConnectedSeconds: 0,
  incoming: 0, incomingSeconds: 0, outgoing: 0, outgoingSeconds: 0, missed: 0, rejected: 0, other: 0,
  withRecording: 0,
};

async function ok(response) {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function expectInvalid(response) {
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "INVALID_REQUEST");
  assert.equal(typeof body.requestId, "string");
}

test("returns the contract shape with exact aggregates over IST days", async (t) => {
  const f = await fixture(t);
  await seed(f);
  const response = await f.get(`?${range}`);
  const text = await response.clone().text();
  const body = await ok(response);

  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(Object.keys(body),
    ["requestId", "range", "totals", "previous", "employees", "byType", "byDay", "byHourWeekday", "durationBuckets"]);
  assert.equal(body.requestId, response.headers.get("X-Request-Id"));
  assert.deepEqual(body.range, {
    from: "2026-10-12", to: "2026-10-18", days: 7, timezone: "Asia/Kolkata",
    previousFrom: "2026-10-05", previousTo: "2026-10-11",
  });
  assert.deepEqual(body.totals, {
    total: 9, connected: 7, notConnected: 2, uniqueContacts: 5, talkSeconds: 1054, avgConnectedSeconds: 151,
    incoming: 2, incomingSeconds: 40, outgoing: 3, outgoingSeconds: 910, missed: 1, rejected: 1, other: 2,
    withRecording: 1,
  });
  // Unique contacts are counted per scope, not summed: 2 + 3 + 1 per employee, 5 overall.
  assert.equal(body.employees.reduce((sum, e) => sum + e.uniqueContacts, 0), 6);
  assert.deepEqual(body.previous, {
    ...zeroMetrics, total: 2, connected: 2, notConnected: 0, uniqueContacts: 2, talkSeconds: 260,
    avgConnectedSeconds: 130, incoming: 1, incomingSeconds: 200, outgoing: 1, outgoingSeconds: 60,
  });
  // Equal total (4) is ordered by name; the smaller total (Aaron) is last even though it sorts first by name.
  assert.deepEqual(body.employees.map((e) => e.name), ["Alice Synthetic", "Bob Synthetic", "Aaron Synthetic"]);
  assert.deepEqual(body.employees, [
    { id: f.people.alice.employee.id, name: "Alice Synthetic", ...aliceMetrics },
    { id: f.people.bob.employee.id, name: "Bob Synthetic", ...bobMetrics },
    { id: f.people.aaron.employee.id, name: "Aaron Synthetic", ...aaronMetrics },
  ]);
  assert.deepEqual(body.byType, [
    { type: "incoming", count: 2, seconds: 40 },
    { type: "outgoing", count: 3, seconds: 910 },
    { type: "missed", count: 1, seconds: 0 },
    { type: "rejected", count: 1, seconds: 0 },
    { type: "blocked", count: 0, seconds: 0 },
    { type: "voicemail", count: 1, seconds: 45 },
    { type: "answered_externally", count: 1, seconds: 59 },
    { type: "unknown", count: 0, seconds: 0 },
  ]);

  assert.deepEqual(body.byDay.map((day) => day.date),
    ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
  for (const day of body.byDay) assert.deepEqual(Object.keys(day.types), types);
  const day = (date) => body.byDay.find((entry) => entry.date === date);
  assert.deepEqual([day("2026-10-12").total, day("2026-10-12").connected, day("2026-10-12").talkSeconds], [3, 3, 160]);
  assert.deepEqual(day("2026-10-12").types.incoming, { count: 2, seconds: 40 });
  assert.deepEqual(day("2026-10-12").types.outgoing, { count: 1, seconds: 120 });
  // 2026-10-13T20:00Z is 01:30 IST on the 14th.
  assert.deepEqual([day("2026-10-13").total, day("2026-10-14").total], [0, 4]);
  assert.deepEqual([day("2026-10-14").connected, day("2026-10-14").talkSeconds], [2, 745]);
  assert.deepEqual(day("2026-10-14").types.missed, { count: 1, seconds: 0 });
  assert.deepEqual(day("2026-10-14").types.voicemail, { count: 1, seconds: 45 });
  assert.deepEqual(day("2026-10-15").types.outgoing, { count: 1, seconds: 90 });
  assert.deepEqual(day("2026-10-18").types.answered_externally, { count: 1, seconds: 59 });
  assert.deepEqual(day("2026-10-16"), {
    date: "2026-10-16", total: 0, connected: 0, talkSeconds: 0,
    types: Object.fromEntries(types.map((type) => [type, { count: 0, seconds: 0 }])),
  });
  assert.equal(body.byDay.reduce((sum, entry) => sum + entry.total, 0), body.totals.total);

  assert.equal(body.byHourWeekday.length, 168);
  assert.deepEqual(body.byHourWeekday.slice(0, 2), [
    { weekday: 0, hour: 0, count: 0 }, { weekday: 0, hour: 1, count: 0 },
  ]);
  assert.deepEqual(body.byHourWeekday.at(-1), { weekday: 6, hour: 23, count: 0 });
  assert.deepEqual(
    body.byHourWeekday.filter((cell) => cell.count > 0),
    [
      { weekday: 0, hour: 23, count: 1 },
      { weekday: 1, hour: 0, count: 1 },
      { weekday: 1, hour: 9, count: 2 },
      { weekday: 3, hour: 1, count: 1 },
      { weekday: 3, hour: 10, count: 3 },
      { weekday: 4, hour: 15, count: 1 },
    ],
  );
  assert.deepEqual(body.durationBuckets, [
    { key: "1-29s", label: "1-29s", count: 1 },
    { key: "30-59s", label: "30-59s", count: 3 },
    { key: "1-3m", label: "1-3m", count: 2 },
    { key: "3-10m", label: "3-10m", count: 0 },
    { key: "10m+", label: "10m+", count: 1 },
  ]);

  // Aggregates only: no phone numbers, recording names or URLs.
  for (const forbidden of [...Object.values(numbers), "98000000", "secret", "example.invalid", "remoteNumber", ".m4a"]) {
    assert.ok(!text.includes(forbidden), `response leaks ${forbidden}`);
  }
});

test("IST day boundaries are inclusive of 23:59:59.999 and exclusive of the next midnight", async (t) => {
  const f = await fixture(t);
  await f.addLog("alice", "2026-10-09T18:29:59.999Z", 5, "incoming", numbers.N1); // IST 10-09 23:59:59.999
  await f.addLog("alice", "2026-10-09T18:30:00.000Z", 5, "incoming", numbers.N1); // IST 10-10 00:00
  await f.addLog("alice", "2026-10-10T18:29:59.999Z", 5, "incoming", numbers.N1); // IST 10-10 23:59:59.999
  await f.addLog("alice", "2026-10-10T18:30:00.000Z", 5, "incoming", numbers.N1); // IST 10-11 00:00

  const one = await ok(await f.get("?from=2026-10-10&to=2026-10-10"));
  assert.equal(one.totals.total, 2);
  assert.deepEqual(one.byDay.map((d) => [d.date, d.total]), [["2026-10-10", 2]]);
  // Each of the two sides of midnight lands in the adjacent day's window.
  assert.equal((await ok(await f.get("?from=2026-10-09&to=2026-10-09"))).totals.total, 1);
  assert.equal((await ok(await f.get("?from=2026-10-11&to=2026-10-11"))).totals.total, 1);
  const two = await ok(await f.get("?from=2026-10-10&to=2026-10-11"));
  assert.deepEqual(two.byDay.map((d) => d.total), [2, 1]);
  assert.equal(two.previous.total, 1);
  // IST 00:00 is weekday/hour 0 of its day, IST 23:59 is hour 23 (2026-10-10 is a Saturday).
  const cells = (await ok(await f.get("?from=2026-10-10&to=2026-10-10"))).byHourWeekday.filter((c) => c.count);
  assert.deepEqual(cells, [{ weekday: 6, hour: 0, count: 1 }, { weekday: 6, hour: 23, count: 1 }]);
});

test("deleted logs are excluded and filters apply to the window and the previous window", async (t) => {
  const f = await fixture(t);
  await seed(f);
  const alice = f.people.alice.employee.id;
  const bob = f.people.bob.employee.id;

  const onlyAlice = await ok(await f.get(`?${range}&employeeIds=${alice}`));
  assert.deepEqual(onlyAlice.totals, aliceMetrics);
  assert.equal(onlyAlice.previous.total, 1);
  assert.deepEqual(onlyAlice.employees.map((e) => e.name), ["Alice Synthetic"]);

  const both = await ok(await f.get(`?${range}&employeeIds=${alice},${bob},${alice}`));
  assert.deepEqual(both.employees.map((e) => e.id), [alice, bob]);
  assert.equal(both.totals.total, 8);

  const outgoing = await ok(await f.get(`?${range}&callTypes=outgoing`));
  assert.equal(outgoing.totals.total, 3);
  assert.equal(outgoing.totals.outgoingSeconds, 910);
  assert.equal(outgoing.totals.incoming, 0);
  assert.equal(outgoing.previous.total, 1);
  assert.deepEqual(outgoing.byType.filter((t2) => t2.count).map((t2) => t2.type), ["outgoing"]);
  assert.equal(outgoing.byType.length, 8);

  const combined = await ok(await f.get(`?${range}&employeeIds=${bob}&callTypes=incoming,outgoing`));
  assert.equal(combined.totals.total, 1);
  assert.equal(combined.totals.talkSeconds, 700);
  assert.equal(combined.previous.total, 1);

  // A well-formed id that matches nothing is an empty result, not an error.
  const none = await ok(await f.get(`?${range}&employeeIds=emp_does-not-exist`));
  assert.deepEqual(none.totals, zeroMetrics);
  assert.deepEqual(none.employees, []);
});

test("empty windows are zero filled", async (t) => {
  const f = await fixture(t);
  const body = await ok(await f.get("?from=2026-01-01&to=2026-01-07"));
  assert.deepEqual(body.totals, zeroMetrics);
  assert.deepEqual(body.previous, zeroMetrics);
  assert.deepEqual(body.employees, []);
  assert.equal(body.byDay.length, 7);
  assert.equal(body.byType.length, 8);
  assert.deepEqual(body.byType.map((entry) => entry.type), types);
  assert.equal(body.byHourWeekday.length, 168);
  assert.ok(body.byHourWeekday.every((cell) => cell.count === 0));
  assert.deepEqual(body.durationBuckets.map((bucket) => bucket.count), [0, 0, 0, 0, 0]);
  for (const day of body.byDay) assert.deepEqual(Object.keys(day.types), types);
});

test("duration buckets cover connected calls only with exact edges", async (t) => {
  const f = await fixture(t);
  const durations = [0, 1, 29, 30, 59, 60, 179, 180, 599, 600, 4000];
  for (const [index, seconds] of durations.entries()) {
    await f.addLog("alice", `2026-09-01T05:00:${String(index).padStart(2, "0")}.000Z`, seconds, "incoming", numbers.N1);
  }
  const body = await ok(await f.get("?from=2026-09-01&to=2026-09-01"));
  assert.deepEqual(body.durationBuckets.map((bucket) => bucket.count), [2, 2, 2, 2, 2]);
  assert.equal(body.totals.connected, 10);
  assert.equal(body.totals.notConnected, 1);
  assert.equal(body.totals.uniqueContacts, 1);
});

test("a 366 day window is accepted and invalid queries return INVALID_REQUEST", async (t) => {
  const f = await fixture(t);
  const long = await ok(await f.get("?from=2025-10-18&to=2026-10-18"));
  assert.equal(long.range.days, 366);
  assert.equal(long.byDay.length, 366);
  assert.equal(long.range.previousFrom, "2024-10-17");
  assert.equal(long.range.previousTo, "2025-10-17");
  assert.equal((await ok(await f.get("?from=2026-10-18&to=2026-10-18"))).range.days, 1);

  const manyIds = Array.from({ length: 51 }, (_, index) => `emp_${index}`).join(",");
  const bad = [
    "?from=2026-10-18&to=2026-10-17",
    "?from=2025-10-17&to=2026-10-18",
    "?from=2026-02-30&to=2026-03-01",
    "?from=2026-1-1&to=2026-10-18",
    "?from=yesterday",
    "?to=2026-10-18T00:00:00Z",
    "?callTypes=incoming,bogus",
    "?callTypes=incoming,incoming,incoming,incoming,incoming,incoming,incoming,incoming,incoming",
    "?employeeIds=not-an-employee",
    "?employeeIds=emp_a,,emp_b",
    "?employeeIds=emp_a,%20emp_b",
    `?employeeIds=${manyIds}`,
    "?from=2026-10-01&from=2026-10-02",
    "?employeeIds=emp_a&employeeIds=emp_b",
    "?foo=bar",
    "?limit=5",
  ];
  for (const query of bad) await expectInvalid(await f.get(query));
});

test("requires administrator authorization", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get("", {})).status, 401);
  assert.equal((await f.get("", { Authorization: "Bearer wrong" })).status, 401);
});

test("defaults to the last 7 days ending today in IST", async (t) => {
  const f = await fixture(t);
  await f.addLog("alice", "2026-10-12T04:00:00.000Z", 10, "incoming", numbers.N1); // IST 10-12 (before default window)
  await f.addLog("alice", "2026-10-18T20:00:00.000Z", 10, "incoming", numbers.N1); // IST 10-19 01:30
  const clockApp = (now) => {
    const app = createAnalyticsTestApp(now);
    return (query) => app.request(`/v1/admin/analytics/calls${query}`, {}, { DB: f.DB });
  };
  // 20:00Z on the 18th is already the 19th in IST.
  const late = clockApp("2026-10-18T20:00:00.000Z");
  const defaults = await ok(await late(""));
  assert.equal(defaults.requestId, "req_analytics_test");
  assert.equal(defaults.range.to, "2026-10-19");
  assert.equal(defaults.range.from, "2026-10-13");
  assert.equal(defaults.range.days, 7);
  assert.equal(defaults.totals.total, 1);
  // 18:29:59Z on the 18th is still the 18th in IST.
  const early = await ok(await clockApp("2026-10-18T18:29:59.999Z")(""));
  assert.deepEqual([early.range.from, early.range.to], ["2026-10-12", "2026-10-18"]);
  assert.equal(early.totals.total, 1);
  // Each end defaults independently of the other.
  const onlyFrom = await ok(await late("?from=2026-10-15"));
  assert.deepEqual([onlyFrom.range.from, onlyFrom.range.to, onlyFrom.range.days], ["2026-10-15", "2026-10-19", 5]);
  const onlyTo = await ok(await late("?to=2026-10-14"));
  assert.deepEqual([onlyTo.range.from, onlyTo.range.to], ["2026-10-08", "2026-10-14"]);
  await expectInvalid(await late("?from=2026-10-20"));
});
