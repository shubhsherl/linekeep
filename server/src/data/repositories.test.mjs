import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unstable_splitSqlQuery } from "wrangler";
import test from "node:test";

import { createDatabase, loadModule } from "./test-support.mjs";

const { createIdentityRepository } = await loadModule("./identity.ts");
const { createCallRepository, InvalidCallStateError } =
  await loadModule("./calls.ts");
const secret = "synthetic-test-key-not-for-deployment";
const start = "2026-09-24T12:00:00.000Z";
const expiry = "2026-09-24T13:00:00Z";

async function fixture(context) {
  const db = await createDatabase(context);
  let now = new Date(start);
  const clock = () => now;
  const identity = createIdentityRepository(db, secret, clock);
  const calls = createCallRepository(db, clock);
  const employee = await identity.createEmployee({
    name: "Synthetic employee",
  });
  async function register(employeeId = employee.id) {
    const invitation = await identity.createInvitation(employeeId, expiry);
    return identity.redeemInvitation(invitation.invitationCode, {
      model: "Test device",
      appVersion: "0.1.0",
    });
  }
  return {
    db,
    identity,
    calls,
    employee,
    register,
    setTime: (value) => {
      now = new Date(value);
    },
  };
}

function recording(deviceId, fingerprint = "a".repeat(64), extra = {}) {
  return {
    deviceId,
    fingerprint,
    displayName: "Synthetic recording.m4a",
    contentType: "audio/mp4",
    expectedBytes: 4,
    matchStatus: "unmatched",
    ...extra,
  };
}

test("concurrent redemption creates exactly one credential and never stores either plaintext secret", async (t) => {
  const { db, identity, employee } = await fixture(t);
  const invitation = await identity.createInvitation(employee.id, expiry);
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      identity.redeemInvitation(invitation.invitationCode, {
        model: "Synthetic",
      }),
    ),
  );
  const winners = results.filter((result) => result !== null);
  assert.equal(winners.length, 1);
  const winner = winners[0];
  assert.deepEqual(winner.employee, { id: employee.id, name: employee.name });
  assert.equal(
    (await identity.authenticateDevice(winner.deviceToken)).id,
    winner.device.id,
  );
  assert.equal(
    await identity.redeemInvitation(invitation.invitationCode, {}),
    null,
  );
  assert.equal((await identity.getInvitation(invitation.id)).redeemedAt, start);
  const storedInvitations = (
    await db.prepare("SELECT * FROM invitations").all()
  ).results;
  const storedDevices = (await db.prepare("SELECT * FROM devices").all())
    .results;
  assert.equal(storedDevices.length, 1);
  assert.equal(
    storedDevices[0].token_hash,
    createHmac("sha256", secret)
      .update(`calltracker:device:${winner.deviceToken}`)
      .digest("hex"),
  );
  assert.equal(
    storedInvitations[0].code_hash,
    createHmac("sha256", secret)
      .update(`calltracker:invitation:${invitation.invitationCode}`)
      .digest("hex"),
  );
  const persisted = JSON.stringify([storedDevices, storedInvitations]);
  assert.equal(persisted.includes(winner.deviceToken), false);
  assert.equal(persisted.includes(invitation.invitationCode), false);
  assert.equal(
    JSON.stringify(await identity.getDevice(winner.device.id)).includes(
      storedDevices[0].token_hash,
    ),
    false,
  );
});

test("a failed redemption transaction rolls back device creation and leaves the invitation usable", async (t) => {
  const { db, identity, employee } = await fixture(t);
  const invitation = await identity.createInvitation(employee.id, expiry);
  await db
    .prepare(
      "CREATE TRIGGER reject_redemption BEFORE UPDATE ON invitations BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END",
    )
    .run();
  await assert.rejects(
    identity.redeemInvitation(invitation.invitationCode, {}),
  );
  assert.equal(
    (await identity.getInvitation(invitation.id)).redeemedAt,
    undefined,
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS count FROM devices").first()).count,
    0,
  );
  await db.prepare("DROP TRIGGER reject_redemption").run();
  const registered = await identity.redeemInvitation(
    invitation.invitationCode,
    {},
  );
  assert.equal(
    (await identity.authenticateDevice(registered.deviceToken)).id,
    registered.device.id,
  );
});

test("invitations reject expiry at the exact boundary and cannot register an inactive employee", async (t) => {
  const { identity, employee, setTime } = await fixture(t);
  const invitation = await identity.createInvitation(employee.id, expiry);
  await identity.setEmployeeActive(employee.id, false);
  assert.equal(
    await identity.redeemInvitation(invitation.invitationCode, {}),
    null,
  );
  assert.equal(await identity.createInvitation(employee.id, expiry), null);
  assert.equal(
    (await identity.getInvitation(invitation.id)).redeemedAt,
    undefined,
  );
  await identity.setEmployeeActive(employee.id, true);
  setTime("2026-09-24T12:59:59.999Z");
  const valid = await identity.createInvitation(employee.id, expiry);
  assert.equal(
    (await identity.redeemInvitation(valid.invitationCode, {})).employee.id,
    employee.id,
  );
  setTime(expiry);
  assert.equal(
    await identity.redeemInvitation(invitation.invitationCode, {}),
    null,
  );
  assert.equal(
    (await identity.getInvitation(invitation.id)).redeemedAt,
    undefined,
  );
  await assert.rejects(
    identity.createInvitation(employee.id, expiry),
    RangeError,
  );
  assert.equal(await identity.redeemInvitation("not-an-invitation", {}), null);
});

test("authentication, revocation, and diagnostic heartbeats remain isolated per device", async (t) => {
  const { identity, employee, register, setTime } = await fixture(t);
  const first = await register();
  const second = await register();
  assert.equal(await identity.authenticateDevice("invalid"), null);
  assert.equal(
    await identity.authenticateDevice(`ctd_${"0".repeat(64)}`),
    null,
  );
  assert.equal(
    await createIdentityRepository(
      await createDatabase(t),
      secret,
    ).authenticateDevice(first.deviceToken),
    null,
  );
  await identity.recordHeartbeat(first.device.id, {
    appVersion: "0.2.0",
    pendingUploads: 3,
    lastSuccessfulUploadAt: "2026-09-24T11:50:00Z",
  });
  setTime("2026-09-24T12:05:00Z");
  const heartbeat = await identity.recordHeartbeat(first.device.id, {
    appVersion: "0.2.1",
    pendingUploads: 0,
  });
  assert.equal(heartbeat.lastSuccessfulUploadAt, "2026-09-24T11:50:00.000Z");
  assert.equal(heartbeat.lastSeenAt, "2026-09-24T12:05:00.000Z");
  assert.equal(heartbeat.pendingUploads, 0);
  assert.equal(
    (await identity.getDevice(second.device.id)).lastSeenAt,
    undefined,
  );
  const revoked = await identity.revokeDevice(first.device.id);
  setTime("2026-09-24T12:06:00Z");
  assert.equal(
    (await identity.revokeDevice(first.device.id)).revokedAt,
    revoked.revokedAt,
  );
  assert.equal(await identity.authenticateDevice(first.deviceToken), null);
  assert.equal(
    await identity.recordHeartbeat(first.device.id, {
      appVersion: "0.3.0",
      pendingUploads: 0,
    }),
    null,
  );
  assert.equal(
    (await identity.authenticateDevice(second.deviceToken)).id,
    second.device.id,
  );
  await identity.setEmployeeActive(employee.id, false);
  assert.equal(await identity.authenticateDevice(second.deviceToken), null);
  await identity.setEmployeeActive(employee.id, true);
  assert.equal(
    (await identity.authenticateDevice(second.deviceToken)).id,
    second.device.id,
  );
  assert.equal(await identity.authenticateDevice(first.deviceToken), null);
});

test("concurrent prepare reuses one immutable recording per device and isolates other devices", async (t) => {
  const { calls, identity, employee, register } = await fixture(t);
  const first = await register();
  const secondEmployee = await identity.createEmployee({
    name: "Another synthetic employee",
  });
  const second = await register(secondEmployee.id);
  const input = recording(first.device.id);
  const prepared = await Promise.all(
    Array.from({ length: 8 }, () => calls.createPending(input)),
  );
  const initial = prepared[0];
  assert.deepEqual(
    new Set(prepared.map((item) => item.id)),
    new Set([initial.id]),
  );
  assert.equal(initial.employeeId, employee.id);
  assert.equal(initial.recordedAt, undefined);
  const replay = await calls.createPending({
    ...input,
    displayName: "changed",
    expectedBytes: 99,
  });
  assert.deepEqual(replay, initial);
  const isolated = await calls.createPending(recording(second.device.id));
  assert.notEqual(isolated.id, initial.id);
  assert.notEqual(isolated.objectKey, initial.objectKey);
  assert.equal(isolated.employeeId, secondEmployee.id);
  assert.equal(await calls.getForDevice(initial.id, second.device.id), null);
  await identity.revokeDevice(first.device.id);
  assert.equal(await calls.createPending(input), null);
  assert.deepEqual(
    (await calls.list({ employeeId: employee.id })).items.map(
      (item) => item.id,
    ),
    [initial.id],
  );
});

test("call state transitions reject cross-device completion, size mismatches, and resurrection", async (t) => {
  const { calls, register, setTime } = await fixture(t);
  const first = await register();
  const second = await register();
  const input = recording(first.device.id);
  const prepared = await calls.createPending(input);
  assert.equal(
    await calls.complete(prepared.id, second.device.id, { actualBytes: 4 }),
    null,
  );
  await assert.rejects(
    calls.complete(prepared.id, first.device.id, { actualBytes: 3 }),
    InvalidCallStateError,
  );
  assert.equal((await calls.getById(prepared.id)).uploadStatus, "pending");
  await calls.markFailed(prepared.id, first.device.id);
  await assert.rejects(
    calls.complete(prepared.id, first.device.id, { actualBytes: 4 }),
    InvalidCallStateError,
  );
  assert.equal(
    (await calls.retryFailed(prepared.id, first.device.id)).uploadStatus,
    "pending",
  );
  const complete = await calls.complete(prepared.id, first.device.id, {
    actualBytes: 4,
    etag: "synthetic-etag",
  });
  setTime("2026-09-24T12:05:00Z");
  assert.deepEqual(
    await calls.complete(prepared.id, first.device.id, { actualBytes: 4 }),
    complete,
  );
  assert.deepEqual(await calls.createPending(input), complete);
  await assert.rejects(
    calls.markFailed(prepared.id, first.device.id),
    InvalidCallStateError,
  );
  const deleted = await calls.markDeleted(prepared.id);
  setTime("2026-09-24T12:06:00Z");
  assert.deepEqual(await calls.markDeleted(prepared.id), deleted);
  assert.equal((await calls.createPending(input)).uploadStatus, "deleted");
  await assert.rejects(
    calls.retryFailed(prepared.id, first.device.id),
    InvalidCallStateError,
  );
  await assert.rejects(
    calls.complete(prepared.id, first.device.id, { actualBytes: 4 }),
    InvalidCallStateError,
  );
});

test("completion checks current device and employee authorization atomically without changing completed replays", async (t) => {
  const { calls, identity, employee, register } = await fixture(t);
  const first = await register();
  const second = await register();
  const revokedPending = await calls.createPending(recording(first.device.id));
  const inactivePending = await calls.createPending(
    recording(second.device.id),
  );
  const alreadyComplete = await calls.createPending(
    recording(first.device.id, "b".repeat(64)),
  );
  const completed = await calls.complete(alreadyComplete.id, first.device.id, {
    actualBytes: 4,
    etag: "verified-before-revocation",
  });

  // An earlier HTTP authorization decision must not authorize a later transition.
  assert.equal(
    (await identity.authenticateDevice(first.deviceToken)).id,
    first.device.id,
  );
  await identity.revokeDevice(first.device.id);
  await assert.rejects(
    calls.complete(revokedPending.id, first.device.id, { actualBytes: 4 }),
    InvalidCallStateError,
  );
  assert.deepEqual(await calls.getById(revokedPending.id), revokedPending);
  assert.deepEqual(
    await calls.complete(completed.id, first.device.id, { actualBytes: 4 }),
    completed,
  );

  await identity.setEmployeeActive(employee.id, false);
  await assert.rejects(
    calls.complete(inactivePending.id, second.device.id, { actualBytes: 4 }),
    InvalidCallStateError,
  );
  assert.deepEqual(await calls.getById(inactivePending.id), inactivePending);
  await identity.setEmployeeActive(employee.id, true);
  assert.equal(
    (
      await calls.complete(inactivePending.id, second.device.id, {
        actualBytes: 4,
      })
    ).uploadStatus,
    "complete",
  );
});

test("keyset pagination breaks timestamp ties and does not repeat rows after newer inserts", async (t) => {
  const { calls, register } = await fixture(t);
  const { device } = await register();
  const rows = await Promise.all(
    ["1", "2", "3"].map((fingerprint) =>
      calls.createPending(recording(device.id, fingerprint.repeat(64))),
    ),
  );
  const expected = rows
    .map((row) => row.id)
    .sort()
    .reverse();
  const first = await calls.list({ limit: 1 });
  assert.deepEqual(
    first.items.map((row) => row.id),
    expected.slice(0, 1),
  );
  await calls.createPending(
    recording(device.id, "4".repeat(64), {
      recordedAt: "2026-09-24T12:10:00Z",
    }),
  );
  const second = await calls.list({ limit: 1, cursor: first.nextCursor });
  const third = await calls.list({ limit: 1, cursor: second.nextCursor });
  assert.deepEqual(
    [...first.items, ...second.items, ...third.items].map((row) => row.id),
    expected,
  );
  assert.equal(third.nextCursor, null);
});

test("list filters use canonical UTC dates and treat search wildcards as literal characters", async (t) => {
  const { calls, employee, register, identity } = await fixture(t);
  const { device } = await register();
  const metadata = {
    recordedAt: "2026-09-24T11:00:00Z",
    direction: "outgoing",
    remoteNumber: "test_100%",
    matchStatus: "filename",
  };
  const wanted = await calls.createPending(
    recording(device.id, "1".repeat(64), metadata),
  );
  await calls.complete(wanted.id, device.id, { actualBytes: 4 });
  await calls.createPending(
    recording(device.id, "2".repeat(64), {
      ...metadata,
      direction: "incoming",
    }),
  );
  await calls.createPending(
    recording(device.id, "3".repeat(64), {
      ...metadata,
      remoteNumber: "testA1000",
    }),
  );
  const otherEmployee = await identity.createEmployee({ name: "Other" });
  const other = await register(otherEmployee.id);
  await calls.createPending(
    recording(other.device.id, "4".repeat(64), metadata),
  );
  const filtered = await calls.list({
    employeeId: employee.id,
    direction: "outgoing",
    number: "_100%",
    from: "2026-09-24T11:00:00.000Z",
    to: "2026-09-24T11:00:00Z",
    status: "complete",
  });
  assert.deepEqual(
    filtered.items.map((row) => row.id),
    [wanted.id],
  );
  assert.deepEqual(filtered.items[0].employee, {
    id: employee.id,
    name: employee.name,
  });
  assert.equal(filtered.items[0].recordedAt, "2026-09-24T11:00:00.000Z");
  assert.deepEqual(
    (await calls.list({ employeeId: employee.id, number: "_100%" })).items
      .map((row) => row.id)
      .sort(),
    [
      wanted.id,
      (await calls.list({ direction: "incoming" })).items[0].id,
    ].sort(),
  );
  assert.deepEqual((await calls.list({ number: "' OR 1=1 --" })).items, []);
});

test("invalid timestamps, fingerprints, byte counts, and page bounds cannot persist data", async (t) => {
  const { identity, calls, employee, register } = await fixture(t);
  const { device } = await register();
  const input = recording(device.id);
  await assert.rejects(
    calls.createPending({ ...input, recordedAt: "2026-09-24T12:00:00+05:30" }),
  );
  await assert.rejects(
    calls.createPending({ ...input, recordedAt: "2026-02-30T12:00:00Z" }),
  );
  await assert.rejects(
    calls.createPending({ ...input, fingerprint: "not-a-fingerprint" }),
  );
  await assert.rejects(calls.createPending({ ...input, expectedBytes: 0 }));
  await assert.rejects(calls.list({ limit: 101 }));
  await assert.rejects(calls.list({ from: expiry, to: start }));
  await assert.rejects(
    identity.createInvitation(employee.id, "2026-09-24T13:00:00+00:00"),
  );
  assert.deepEqual((await calls.list()).items, []);
});

test("handover attributes offline recordings at exact boundaries and preserves timestampless replays", async (t) => {
  const f = await fixture(t);
  const enrolled = await f.register();
  const next = await f.identity.createEmployee({ name: "Next employee" });
  const pending = await f.calls.createPending(recording(enrolled.device.id));
  f.setTime("2026-09-24T12:10:00Z");
  const assigned = await f.identity.reassignDevice(enrolled.device.id, next.id);
  assert.equal(
    (await f.identity.authenticateDevice(enrolled.deviceToken)).employeeId,
    next.id,
  );
  assert.deepEqual(
    await f.calls.createPending(recording(enrolled.device.id)),
    pending,
  );
  await assert.rejects(
    f.calls.createPending(recording(enrolled.device.id, "b".repeat(64))),
    InvalidCallStateError,
  );
  const before = await f.calls.createPending(
    recording(enrolled.device.id, "c".repeat(64), {
      recordedAt: "2026-09-24T12:09:59.999Z",
    }),
  );
  const boundary = await f.calls.createPending(
    recording(enrolled.device.id, "d".repeat(64), {
      recordedAt: assigned.assignedAt,
    }),
  );
  const preEnrollment = await f.calls.createPending(
    recording(enrolled.device.id, "e".repeat(64), {
      recordedAt: "2026-09-23T12:00:00Z",
    }),
  );
  assert.equal(before.employeeId, f.employee.id);
  assert.equal(preEnrollment.employeeId, f.employee.id);
  assert.equal(boundary.employeeId, next.id);
  assert.equal(
    (await f.calls.complete(pending.id, enrolled.device.id, { actualBytes: 4 }))
      .employeeId,
    f.employee.id,
  );
  await f.identity.setEmployeeActive(f.employee.id, false);
  assert.equal(await f.calls.isActiveOwner(before.id), false);
  await assert.rejects(
    f.calls.complete(before.id, enrolled.device.id, { actualBytes: 4 }),
    InvalidCallStateError,
  );
  await f.identity.setEmployeeActive(f.employee.id, true);
  await f.identity.setEmployeeActive(next.id, false);
  assert.equal(await f.calls.isActiveOwner(before.id), false);
  await assert.rejects(
    f.calls.complete(before.id, enrolled.device.id, { actualBytes: 4 }),
    InvalidCallStateError,
  );
});

test("assignment history rolls back with the current owner and preserves same-millisecond handovers", async (t) => {
  const f = await fixture(t);
  const enrolled = await f.register();
  const next = await f.identity.createEmployee({ name: "Next employee" });
  await f.db
    .prepare(
      `CREATE TRIGGER reject_assignment BEFORE INSERT ON device_assignments
    BEGIN SELECT RAISE(ABORT, 'synthetic history failure'); END`,
    )
    .run();
  await assert.rejects(f.identity.reassignDevice(enrolled.device.id, next.id));
  assert.equal(
    (await f.identity.authenticateDevice(enrolled.deviceToken)).employeeId,
    f.employee.id,
  );
  await f.db.prepare("DROP TRIGGER reject_assignment").run();
  const first = await f.identity.reassignDevice(enrolled.device.id, next.id);
  const repeated = await f.identity.reassignDevice(enrolled.device.id, next.id);
  assert.equal(repeated.assignedAt, first.assignedAt);
  const second = await f.identity.reassignDevice(
    enrolled.device.id,
    f.employee.id,
  );
  assert.ok(second.assignedAt > first.assignedAt);
  const atFirst = await f.calls.createPending(
    recording(enrolled.device.id, "a".repeat(64), {
      recordedAt: first.assignedAt,
    }),
  );
  const atSecond = await f.calls.createPending(
    recording(enrolled.device.id, "b".repeat(64), {
      recordedAt: second.assignedAt,
    }),
  );
  assert.equal(atFirst.employeeId, next.id);
  assert.equal(atSecond.employeeId, f.employee.id);
  await f.identity.setEmployeeActive(next.id, false);
  assert.equal(
    await f.identity.reassignDevice(enrolled.device.id, next.id),
    null,
  );
  await f.identity.revokeDevice(enrolled.device.id);
  assert.equal(
    await f.identity.reassignDevice(enrolled.device.id, f.employee.id),
    null,
  );
});

test("directory pagination includes employees without calls and name edits preserve legacy metadata", async (t) => {
  const f = await fixture(t);
  const named = await f.identity.createEmployee({
    name: "Old name",
    phoneNumber: "+15555550123",
  });
  const third = await f.identity.createEmployee({ name: "Third employee" });
  const first = await f.identity.listEmployees({ limit: 2 });
  const second = await f.identity.listEmployees({
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    [...first.items, ...second.items].map((row) => row.id),
    [f.employee.id, named.id, third.id].sort().reverse(),
  );
  assert.equal(second.nextCursor, null);
  const edited = await f.identity.updateEmployee(named.id, {
    name: " Renamed ",
  });
  assert.equal(edited.name, "Renamed");
  assert.equal(edited.phoneNumber, named.phoneNumber);
  await assert.rejects(f.identity.updateEmployee(named.id, { name: " " }));
  await assert.rejects(f.identity.listEmployees({ limit: 101 }));
  const one = await f.register(named.id);
  const two = await f.register(named.id);
  const other = await f.register(third.id);
  const devices = await f.identity.listDevices({
    employeeId: named.id,
    limit: 1,
  });
  const rest = await f.identity.listDevices({
    employeeId: named.id,
    limit: 1,
    cursor: devices.nextCursor,
  });
  assert.deepEqual(
    new Set([...devices.items, ...rest.items].map((row) => row.id)),
    new Set([one.device.id, two.device.id]),
  );
  assert.equal(rest.nextCursor, null);
  assert.equal(devices.items[0].employee.name, "Renamed");
  assert.equal(
    (await f.identity.getManagedDevice(other.device.id)).employeeId,
    third.id,
  );
});

test("invitation history is paginated and revocation cannot redeem or revoke an enrolled device", async (t) => {
  const f = await fixture(t);
  const unused = await f.identity.createInvitation(f.employee.id, expiry);
  const used = await f.identity.createInvitation(f.employee.id, expiry);
  const enrolled = await f.identity.redeemInvitation(used.invitationCode, {});
  const revoked = await f.identity.revokeInvitation(f.employee.id, unused.id);
  assert.equal(revoked.status, "revoked");
  assert.equal(
    await f.identity.redeemInvitation(unused.invitationCode, {}),
    null,
  );
  assert.deepEqual(
    await f.identity.revokeInvitation(f.employee.id, unused.id),
    revoked,
  );
  assert.equal(
    (await f.identity.revokeInvitation(f.employee.id, used.id)).status,
    "redeemed",
  );
  assert.equal(
    (await f.identity.authenticateDevice(enrolled.deviceToken)).id,
    enrolled.device.id,
  );
  assert.deepEqual((await f.identity.listInvitations(f.employee.id, { limit: 1 })).items.map((row) => row.id), [used.id]);
  const first = await f.identity.listInvitations(f.employee.id, { limit: 1, includeRevoked: true });
  const second = await f.identity.listInvitations(f.employee.id, {
    limit: 1,
    includeRevoked: true,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    new Set([...first.items, ...second.items].map((row) => row.id)),
    new Set([used.id, unused.id]),
  );
  assert.equal(second.nextCursor, null);
  const other = await f.identity.createEmployee({ name: "Other employee" });
  assert.equal(await f.identity.revokeInvitation(other.id, unused.id), null);
  const expires = await f.identity.createInvitation(f.employee.id, expiry);
  f.setTime(expiry);
  assert.equal(
    (await f.identity.listInvitations(f.employee.id)).items.find(
      (row) => row.id === expires.id,
    ).status,
    "expired",
  );
});

test("old-Worker device inserts receive initial assignment history during the deployment window", async (t) => {
  const f = await fixture(t);
  await f.db
    .prepare(
      `INSERT INTO devices (id, employee_id, token_hash, created_at)
    VALUES (?, ?, ?, ?)`,
    )
    .bind("dev_legacy_worker", f.employee.id, "synthetic-hash", start)
    .run();
  assert.equal(
    (await f.identity.getDevice("dev_legacy_worker")).assignedAt,
    start,
  );
  const next = await f.identity.createEmployee({ name: "Next employee" });
  f.setTime("2026-09-24T12:05:00Z");
  await f.identity.reassignDevice("dev_legacy_worker", next.id);
  const older = await f.calls.createPending(
    recording("dev_legacy_worker", "a".repeat(64), {
      recordedAt: "2026-09-23T12:00:00Z",
    }),
  );
  assert.equal(older.employeeId, f.employee.id);
  const current = await f.calls.createPending(
    recording("dev_legacy_worker", "b".repeat(64), {
      recordedAt: "2026-09-24T12:05:00Z",
    }),
  );
  assert.equal(current.employeeId, next.id);
});

test("concurrent recovery supersedes old codes and rotates exactly one same-enrollment credential", async (t) => {
  const f = await fixture(t);
  const enrolled = await f.register();
  const originalInvitation = enrolled.device.invitationId;
  const pending = await f.calls.createPending(recording(enrolled.device.id));
  const assignmentsBefore = (await f.db.prepare("SELECT * FROM device_assignments WHERE device_id = ?").bind(enrolled.device.id).all()).results;
  const first = await f.identity.createRecoveryInvitation(enrolled.device.id, expiry);
  const issued = await Promise.all(Array.from({ length: 4 }, () => f.identity.createRecoveryInvitation(enrolled.device.id, expiry)));
  assert.equal((await f.identity.authenticateDevice(enrolled.deviceToken)).id, enrolled.device.id);
  assert.equal(await f.identity.redeemInvitation(first.invitationCode, {}), null);
  const summaries = (await f.identity.listInvitations(f.employee.id)).items.filter((row) => row.purpose === "recovery");
  assert.equal(summaries.length, 1);
  const live = issued.find((row) => row.id === summaries[0].id);
  const results = await Promise.all(Array.from({ length: 5 }, () => f.identity.redeemInvitation(live.invitationCode, { model: "Reinstalled", phoneNumbers: [] })));
  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1);
  const winner = winners[0];
  assert.equal(winner.device.id, enrolled.device.id);
  assert.equal(winner.device.invitationId, originalInvitation);
  assert.equal(winner.device.lastInvitationId, live.id);
  assert.equal(winner.device.model, "Reinstalled");
  assert.equal(await f.identity.authenticateDevice(enrolled.deviceToken), null);
  assert.equal((await f.identity.authenticateDevice(winner.deviceToken)).id, enrolled.device.id);
  assert.equal(await f.identity.redeemInvitation(live.invitationCode, {}), null);
  assert.deepEqual(await f.calls.getById(pending.id), pending);
  assert.deepEqual((await f.db.prepare("SELECT * FROM device_assignments WHERE device_id = ?").bind(enrolled.device.id).all()).results, assignmentsBefore);
  assert.equal((await f.calls.complete(pending.id, winner.device.id, { actualBytes: 4 })).uploadStatus, "complete");
  const stored = JSON.stringify([
    (await f.db.prepare("SELECT * FROM devices").all()).results,
    (await f.db.prepare("SELECT * FROM invitations").all()).results,
  ]);
  for (const plaintext of [enrolled.deviceToken, winner.deviceToken, first.invitationCode, ...issued.map((row) => row.invitationCode)]) {
    assert.equal(stored.includes(plaintext), false);
  }
});

test("recovery rejects expiry, revocation, inactive employees and handover-away-and-back without partial mutation", async (t) => {
  for (const failure of ["expired", "invitation-revoked", "device-revoked", "inactive", "handover"]) {
    await t.test(failure, async (t) => {
      const f = await fixture(t);
      const enrolled = await f.register();
      const recovery = await f.identity.createRecoveryInvitation(enrolled.device.id, expiry);
      if (failure === "expired") f.setTime(expiry);
      if (failure === "invitation-revoked") await f.identity.revokeInvitation(f.employee.id, recovery.id);
      if (failure === "device-revoked") await f.identity.revokeDevice(enrolled.device.id);
      if (failure === "inactive") await f.identity.setEmployeeActive(f.employee.id, false);
      if (failure === "handover") {
        const other = await f.identity.createEmployee({ name: "Temporary holder" });
        await f.identity.reassignDevice(enrolled.device.id, other.id);
        await f.identity.reassignDevice(enrolled.device.id, f.employee.id);
      }
      const before = await f.db.prepare("SELECT * FROM devices WHERE id = ?").bind(enrolled.device.id).first();
      assert.equal(await f.identity.redeemInvitation(recovery.invitationCode, { model: "Must not persist" }), null);
      assert.deepEqual(await f.db.prepare("SELECT * FROM devices WHERE id = ?").bind(enrolled.device.id).first(), before);
      assert.equal((await f.identity.getInvitation(recovery.id)).redeemedAt, undefined);
      if (failure === "inactive" || failure === "device-revoked") {
        assert.equal(await f.identity.createRecoveryInvitation(enrolled.device.id, "2026-09-24T14:00:00Z"), null);
        assert.equal((await f.identity.getInvitation(recovery.id)).revokedAt, undefined);
      }
    });
  }
});

test("revoked directory entries are excluded before pagination, including newest revoked entries", async (t) => {
  const f = await fixture(t);
  const first = await f.register();
  f.setTime("2026-09-24T12:01:00Z");
  const second = await f.register();
  f.setTime("2026-09-24T12:02:00Z");
  const revoked = await f.register();
  await f.identity.revokeDevice(revoked.device.id);
  const page = await f.identity.listDevices({ employeeId: f.employee.id, limit: 1 });
  assert.deepEqual(page.items.map((row) => row.id), [second.device.id]);
  const rest = await f.identity.listDevices({ employeeId: f.employee.id, limit: 1, cursor: page.nextCursor });
  assert.deepEqual(rest.items.map((row) => row.id), [first.device.id]);
  assert.equal(rest.nextCursor, null);
  assert.equal((await f.identity.listDevices({ limit: 1, includeRevoked: true })).items[0].id, revoked.device.id);
  const unused = await f.identity.createInvitation(f.employee.id, expiry);
  await f.identity.revokeInvitation(f.employee.id, unused.id);
  const invites = await f.identity.listInvitations(f.employee.id, { limit: 1 });
  assert.equal(invites.items[0].id, revoked.device.invitationId);
  assert.equal((await f.identity.listInvitations(f.employee.id, { includeRevoked: true })).items.some((row) => row.id === unused.id), true);
});

test("legacy provenance backfill requires unique matches in both directions and uses the initial employee", async (t) => {
  const db = await createDatabase(t, "0004_call_history.sql");
  await db.prepare("INSERT INTO employees (id, name, created_at) VALUES ('original', 'Original', ?), ('current', 'Current', ?)").bind(start, start).run();
  for (const [deviceId, createdAt] of [
    ["unique", start], ["ambiguous-device-one", "2026-09-24T12:01:00.000Z"],
    ["ambiguous-device-two", "2026-09-24T12:01:00.000Z"],
    ["ambiguous-invitation", "2026-09-24T12:02:00.000Z"],
    ["unproven", "2026-09-24T12:03:00.000Z"],
  ]) {
    await db.prepare("INSERT INTO devices (id, employee_id, token_hash, created_at) VALUES (?, 'original', ?, ?)")
      .bind(deviceId, `hash-${deviceId}`, createdAt).run();
  }
  for (const [invitationId, redeemedAt] of [
    ["unique-invitation", start], ["two-devices", "2026-09-24T12:01:00.000Z"],
    ["duplicate-one", "2026-09-24T12:02:00.000Z"], ["duplicate-two", "2026-09-24T12:02:00.000Z"],
  ]) {
    await db.prepare("INSERT INTO invitations (id, employee_id, code_hash, expires_at, redeemed_at, created_at) VALUES (?, 'original', ?, ?, ?, ?)")
      .bind(invitationId, `hash-${invitationId}`, expiry, redeemedAt, start).run();
  }
  await db.prepare("UPDATE devices SET employee_id = 'current' WHERE id = 'unique'").run();
  const migration = await readFile(new URL("../../migrations/0005_unified_calls.sql", import.meta.url), "utf8");
  await db.batch(unstable_splitSqlQuery(migration).map((sql) => db.prepare(sql)));
  const identity = createIdentityRepository(db, secret, () => new Date(start));
  const devices = (await identity.listDevices()).items;
  assert.equal(devices.find((row) => row.id === "unique").invitationId, "unique-invitation");
  assert.equal(devices.find((row) => row.id === "unique").lastInvitationId, "unique-invitation");
  for (const row of devices.filter((row) => row.id !== "unique")) {
    assert.equal(row.invitationId, undefined);
    assert.equal(row.lastInvitationId, undefined);
  }
  const invitations = (await identity.listInvitations("original")).items;
  assert.equal(invitations.find((row) => row.id === "unique-invitation").deviceId, "unique");
  for (const row of invitations.filter((row) => row.id !== "unique-invitation")) assert.equal(row.deviceId, undefined);
});
