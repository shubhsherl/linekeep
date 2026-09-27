import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase, loadModule } from "../../data/test-support.mjs";

const { identityRepository } = await loadModule("../modules/identity/index.ts");
const { createIdentityTestApp } = await loadModule(
  "../modules/identity/test-app.ts",
);
const { createIdentityRepository } = await loadModule("./identity.ts");
const secret = "synthetic-identity-http-key-not-for-deployment";

async function fixture(t) {
  const DB = await createDatabase(t);
  const env = { DB, TOKEN_HASH_SECRET: secret, ENVIRONMENT: "development" };
  const app = createIdentityTestApp();
  const request = (path, body, authorization, method = "POST") =>
    app.request(
      path,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify(body),
      },
      env,
    );
  async function register(employeeId) {
    const issued = await request(
      `/v1/admin/employees/${employeeId}/invitations`,
      {},
      "Bearer synthetic-admin",
    );
    assert.equal(issued.status, 201);
    const invitation = await issued.json();
    const response = await request("/v1/device/register", {
      invitationCode: invitation.invitationCode,
      device: {
        model: "Synthetic device",
        manufacturer: "samsung",
        appVersion: "0.1.0",
      },
    });
    assert.equal(response.status, 201);
    return { registration: await response.json(), invitation, response };
  }
  return { DB, env, app, request, register, identity: identityRepository(env) };
}

test("admin onboarding is guarded and registration returns its credential only once", async (t) => {
  const { DB, request, register, identity } = await fixture(t);
  const denied = await request("/v1/admin/employees", {
    name: "Synthetic employee",
  });
  assert.equal(denied.status, 401);
  assert.equal(
    (await DB.prepare("SELECT COUNT(*) AS count FROM employees").first()).count,
    0,
  );
  const created = await request(
    "/v1/admin/employees",
    { name: "Synthetic employee", phoneNumber: "+15555550123" },
    "Bearer synthetic-admin",
  );
  assert.equal(created.status, 201);
  const employeeResponse = await created.json();
  assert.equal(employeeResponse.employee.name, "Synthetic employee");
  assert.equal(employeeResponse.employee.phoneNumber, "+15555550123");
  assert.equal(typeof employeeResponse.requestId, "string");
  const { registration, invitation, response } = await register(
    employeeResponse.employee.id,
  );
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(registration.employee, {
    id: employeeResponse.employee.id,
    name: "Synthetic employee",
  });
  assert.equal(
    (await identity.authenticateDevice(registration.deviceToken)).id,
    registration.deviceId,
  );
  const repeated = await request("/v1/device/register", {
    invitationCode: invitation.invitationCode,
    device: {},
  });
  assert.equal(repeated.status, 401);
  assert.equal(
    (await DB.prepare("SELECT COUNT(*) AS count FROM devices").first()).count,
    1,
  );
});

test("registration rejects an expired invitation without consuming it", async (t) => {
  const { DB, request, identity } = await fixture(t);
  const employee = await identity.createEmployee({ name: "Expiry fixture" });
  const expiredIssuer = createIdentityRepository(
    DB,
    secret,
    () => new Date(Date.now() - 120000),
  );
  const invitation = await expiredIssuer.createInvitation(
    employee.id,
    new Date(Date.now() - 60000).toISOString(),
  );
  const rejected = await request("/v1/device/register", {
    invitationCode: invitation.invitationCode,
    device: {},
  });
  assert.equal(rejected.status, 401);
  assert.equal(
    (await identity.getInvitation(invitation.id)).redeemedAt,
    undefined,
  );
  assert.equal(
    (await DB.prepare("SELECT COUNT(*) AS count FROM devices").first()).count,
    0,
  );
});

test("heartbeat requires a live device credential and revocation affects only that device", async (t) => {
  const { request, register, identity } = await fixture(t);
  const employee = await identity.createEmployee({ name: "Heartbeat fixture" });
  const first = (await register(employee.id)).registration;
  const second = (await register(employee.id)).registration;
  const heartbeat = {
    appVersion: "0.2.0",
    pendingUploads: 3,
    lastSuccessfulUploadAt: "2026-09-24T10:00:00Z",
  };
  assert.equal((await request("/v1/device/heartbeat", heartbeat)).status, 401);
  assert.equal(
    (await request("/v1/device/heartbeat", heartbeat, "Basic invalid")).status,
    401,
  );
  assert.equal(
    (
      await request(
        "/v1/device/heartbeat",
        heartbeat,
        `Bearer ctd_${"0".repeat(64)}`,
      )
    ).status,
    401,
  );
  const accepted = await request(
    "/v1/device/heartbeat",
    heartbeat,
    `Bearer ${first.deviceToken}`,
  );
  assert.equal(accepted.status, 200);
  const body = await accepted.json();
  assert.equal(
    body.serverTime,
    (await identity.getDevice(first.deviceId)).lastSeenAt,
  );
  assert.equal((await identity.getDevice(first.deviceId)).pendingUploads, 3);
  assert.equal(
    (await identity.getDevice(second.deviceId)).lastSeenAt,
    undefined,
  );
  await identity.revokeDevice(first.deviceId);
  assert.equal(
    (
      await request(
        "/v1/device/heartbeat",
        heartbeat,
        `Bearer ${first.deviceToken}`,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await request(
        "/v1/device/heartbeat",
        heartbeat,
        `Bearer ${second.deviceToken}`,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/v1/device/heartbeat",
        { ...heartbeat, pendingUploads: -1 },
        `Bearer ${second.deviceToken}`,
      )
    ).status,
    400,
  );
  assert.equal((await identity.getDevice(second.deviceId)).pendingUploads, 3);
});

test("SIM reports cannot spoof enrollment and heartbeat refreshes assignment without rotating credentials", async (t) => {
  const f = await fixture(t);
  const firstEmployee = await f.identity.createEmployee({
    name: "First employee",
  });
  const nextEmployee = await f.identity.createEmployee({
    name: "Next employee",
  });
  const invitation = await f.identity.createInvitation(
    firstEmployee.id,
    new Date(Date.now() + 60000).toISOString(),
  );
  const response = await f.request("/v1/device/register", {
    invitationCode: invitation.invitationCode,
    device: { phoneNumbers: [" +15555550123 "] },
  });
  assert.equal(response.status, 201);
  const enrolled = await response.json();
  const other = (await f.register(firstEmployee.id)).registration;
  const auth = `Bearer ${enrolled.deviceToken}`;
  const heartbeat = {
    appVersion: "0.3.0",
    pendingUploads: 0,
    deviceId: enrolled.deviceId,
  };
  const reported = await f.identity.getDevice(enrolled.deviceId);
  assert.deepEqual(reported.phoneNumbers, ["+15555550123"]);
  assert.equal(
    (
      await f.request(
        "/v1/device/heartbeat",
        {
          ...heartbeat,
          deviceId: other.deviceId,
          phoneNumbers: ["+15555550456"],
        },
        auth,
      )
    ).status,
    401,
  );
  assert.deepEqual(
    (await f.identity.getDevice(enrolled.deviceId)).phoneNumbers,
    reported.phoneNumbers,
  );
  assert.equal(
    (await f.identity.getDevice(other.deviceId)).phoneNumbersReportedAt,
    undefined,
  );
  await f.identity.reassignDevice(enrolled.deviceId, nextEmployee.id);
  const refresh = await f.request("/v1/device/heartbeat", heartbeat, auth);
  assert.equal(refresh.status, 200);
  const body = await refresh.json();
  assert.equal(body.deviceId, enrolled.deviceId);
  assert.deepEqual(body.employee, {
    id: nextEmployee.id,
    name: nextEmployee.name,
  });
  assert.deepEqual(
    (await f.identity.getDevice(enrolled.deviceId)).phoneNumbers,
    reported.phoneNumbers,
  );
  assert.equal(
    (
      await f.request(
        "/v1/device/heartbeat",
        {
          ...heartbeat,
          phoneNumbers: ["+15555550456", "+15555550789"],
        },
        auth,
      )
    ).status,
    200,
  );
  assert.deepEqual(
    (await f.identity.getDevice(enrolled.deviceId)).phoneNumbers,
    ["+15555550456", "+15555550789"],
  );
  assert.equal(
    (
      await f.request(
        "/v1/device/heartbeat",
        { ...heartbeat, phoneNumbers: [] },
        auth,
      )
    ).status,
    200,
  );
  assert.deepEqual(
    (await f.identity.getDevice(enrolled.deviceId)).phoneNumbers,
    [],
  );
  for (const phoneNumbers of [
    [" "],
    ["x".repeat(65)],
    Array(9).fill("+15555550123"),
  ]) {
    assert.equal(
      (
        await f.request(
          "/v1/device/heartbeat",
          { ...heartbeat, phoneNumbers },
          auth,
        )
      ).status,
      400,
    );
  }
  await f.identity.revokeDevice(enrolled.deviceId);
  assert.equal(
    (await f.request("/v1/device/heartbeat", heartbeat, auth)).status,
    401,
  );
});

test("management routes are guarded, paginate safely, edit names, and never expose credential hashes", async (t) => {
  const f = await fixture(t);
  const employee = await f.identity.createEmployee({ name: "Employee" });
  const next = await f.identity.createEmployee({ name: "Next" });
  const { registration, invitation } = await f.register(employee.id);
  const auth = "Bearer synthetic-admin";
  const routes = [
    ["/v1/admin/employees", "GET"],
    [`/v1/admin/employees/${employee.id}`, "PATCH"],
    ["/v1/admin/devices", "GET"],
    [`/v1/admin/devices/${registration.deviceId}`, "PATCH"],
    [`/v1/admin/devices/${registration.deviceId}/revoke`, "POST"],
    [`/v1/admin/devices/${registration.deviceId}/recovery-invitations`, "POST"],
    [`/v1/admin/employees/${employee.id}/invitations`, "GET"],
    [
      `/v1/admin/employees/${employee.id}/invitations/${invitation.invitationId}/revoke`,
      "POST",
    ],
  ];
  for (const [path, method] of routes) {
    assert.equal(
      (
        await f.request(
          path,
          method === "GET" ? undefined : {},
          undefined,
          method,
        )
      ).status,
      401,
    );
  }
  const first = await (
    await f.request("/v1/admin/employees?limit=1", undefined, auth, "GET")
  ).json();
  const second = await (
    await f.request(
      `/v1/admin/employees?limit=1&cursor=${first.nextCursor}`,
      undefined,
      auth,
      "GET",
    )
  ).json();
  assert.deepEqual(
    new Set([first.items[0].id, second.items[0].id]),
    new Set([employee.id, next.id]),
  );
  assert.equal(second.nextCursor, null);
  for (const query of [
    "limit=101",
    "limit=1&limit=2",
    "cursor=not-valid",
    "unknown=value",
  ]) {
    assert.equal(
      (await f.request(`/v1/admin/employees?${query}`, undefined, auth, "GET"))
        .status,
      400,
    );
  }
  const edit = await f.request(
    `/v1/admin/employees/${employee.id}`,
    { name: "Renamed" },
    auth,
    "PATCH",
  );
  assert.equal(edit.status, 200);
  assert.equal((await edit.json()).employee.name, "Renamed");
  const handover = await f.request(
    `/v1/admin/devices/${registration.deviceId}`,
    { employeeId: next.id },
    auth,
    "PATCH",
  );
  assert.equal(handover.status, 200);
  const device = (await handover.json()).device;
  assert.deepEqual(device.employee, { id: next.id, name: next.name });
  assert.equal(device.id, registration.deviceId);
  const listed = await (
    await f.request(
      `/v1/admin/devices?employeeId=${next.id}`,
      undefined,
      auth,
      "GET",
    )
  ).json();
  assert.deepEqual(
    listed.items.map((item) => item.id),
    [registration.deviceId],
  );
  const history = await (
    await f.request(
      `/v1/admin/employees/${employee.id}/invitations`,
      undefined,
      auth,
      "GET",
    )
  ).json();
  assert.equal(history.items[0].status, "redeemed");
  assert.equal(history.items[0].id, invitation.invitationId);
  for (const item of [device, ...listed.items, ...history.items]) {
    for (const key of [
      "tokenHash",
      "token_hash",
      "codeHash",
      "code_hash",
      "invitationCode",
      "deviceToken",
    ])
      assert.equal(Object.hasOwn(item, key), false);
  }
  const fresh = await (
    await f.request(`/v1/admin/employees/${employee.id}/invitations`, {}, auth)
  ).json();
  const revokeInvite = await f.request(
    `/v1/admin/employees/${employee.id}/invitations/${fresh.invitationId}/revoke`,
    {},
    auth,
  );
  assert.equal((await revokeInvite.json()).invitation.status, "revoked");
  assert.equal(
    (
      await f.request("/v1/device/register", {
        invitationCode: fresh.invitationCode,
        device: {},
      })
    ).status,
    401,
  );
  const revoked = await f.request(
    `/v1/admin/devices/${registration.deviceId}/revoke`,
    {},
    auth,
  );
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).device.id, registration.deviceId);
  assert.equal(
    (
      await f.request(
        `/v1/admin/devices/${registration.deviceId}`,
        { employeeId: employee.id },
        auth,
        "PATCH",
      )
    ).status,
    409,
  );
});

test("actual application applies JSON media-type and size bounds to PATCH", async (t) => {
  const { createApp } = await loadModule("../app.ts");
  const { env } = await fixture(t);
  const app = createApp();
  const path = "/v1/admin/employees/emp_synthetic";
  const wrongType = await app.request(
    path,
    {
      method: "PATCH",
      headers: { "Content-Type": "text/plain" },
      body: '{"name":"Changed"}',
    },
    env,
  );
  assert.equal(wrongType.status, 400);
  const oversized = await app.request(
    path,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(16384) }),
    },
    env,
  );
  assert.equal(oversized.status, 413);
});

test("manager-issued recovery retains enrollment provenance and old bearer credentials stop working", async (t) => {
  const f = await fixture(t);
  const employee = await f.identity.createEmployee({ name: "Recovery employee" });
  const { registration, invitation } = await f.register(employee.id);
  assert.equal(registration.invitationId, invitation.invitationId);
  assert.equal(registration.lastInvitationId, invitation.invitationId);
  const issued = await f.request(`/v1/admin/devices/${registration.deviceId}/recovery-invitations`, {}, "Bearer synthetic-admin");
  assert.equal(issued.status, 201);
  const recovery = await issued.json();
  const redeemed = await f.request("/v1/device/register", { invitationCode: recovery.invitationCode, device: { model: "New install" } });
  assert.equal(redeemed.status, 201);
  const updated = await redeemed.json();
  assert.equal(updated.deviceId, registration.deviceId);
  assert.equal(updated.invitationId, invitation.invitationId);
  assert.equal(updated.lastInvitationId, recovery.invitationId);
  const heartbeat = { deviceId: registration.deviceId, appVersion: "0.3.0", pendingUploads: 0 };
  assert.equal((await f.request("/v1/device/heartbeat", heartbeat, `Bearer ${registration.deviceToken}`)).status, 401);
  const response = await f.request("/v1/device/heartbeat", heartbeat, `Bearer ${updated.deviceToken}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).lastInvitationId, recovery.invitationId);
  assert.equal((await f.request("/v1/device/register", { invitationCode: recovery.invitationCode, device: {} })).status, 401);
  const history = await (await f.request(`/v1/admin/employees/${employee.id}/invitations`, undefined, "Bearer synthetic-admin", "GET")).json();
  const summary = history.items.find((row) => row.id === recovery.invitationId);
  assert.equal(summary.purpose, "recovery");
  assert.equal(summary.recoveryDeviceId, registration.deviceId);
  const unused = await f.identity.createInvitation(employee.id, new Date(Date.now() + 60000).toISOString());
  await f.identity.revokeInvitation(employee.id, unused.id);
  await f.identity.revokeDevice(registration.deviceId);
  for (const [path, hiddenId] of [
    ["/v1/admin/devices", registration.deviceId],
    [`/v1/admin/employees/${employee.id}/invitations`, unused.id],
  ]) {
    const hidden = await (await f.request(path, undefined, "Bearer synthetic-admin", "GET")).json();
    assert.equal(hidden.items.some((row) => row.id === hiddenId), false);
    const included = await (await f.request(`${path}?includeRevoked=true`, undefined, "Bearer synthetic-admin", "GET")).json();
    assert.equal(included.items.some((row) => row.id === hiddenId), true);
    assert.equal(JSON.stringify(included).includes(recovery.invitationCode), false);
  }
  assert.equal((await f.request(`/v1/admin/devices/${registration.deviceId}/recovery-invitations`, {}, "Bearer synthetic-admin")).status, 409);
});
