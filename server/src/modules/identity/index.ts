import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { recordActivity, requestActor, touchEmployeeActivity } from "../../activity/record";
import type { AppBindings } from "../../app";
import {
  createIdentityRepository,
  directoryCursor,
  EmployeeEmailExistsError,
  EmployeeHierarchyError,
  EmployeePhoneExistsError,
  phoneNumbersInput,
  type Device,
  type IdentityRepository,
} from "../../data/identity";
import { id, nonnegativeInteger, utcTimestamp } from "../../data/values";
import type { EmployeeScope } from "../../data/scope";
import type { Env } from "../../env";
import { ApiError } from "../../http/errors";
import { enrollmentQr } from "./enrollment-qr";

export type DeviceBindings = AppBindings & {
  Variables: AppBindings["Variables"] & { device: Device; employeeScope?: EmployeeScope };
};

const repositories = new WeakMap<
  D1Database,
  {
    secret: string;
    repository: IdentityRepository;
  }
>();

/** Keep the imported HMAC key scoped to the database and current environment secret. */
export function identityRepository(env: Env) {
  const secret = env.TOKEN_HASH_SECRET;
  if (!secret) throw new Error("TOKEN_HASH_SECRET is required");
  const cached = repositories.get(env.DB);
  if (cached?.secret === secret) return cached.repository;
  const repository = createIdentityRepository(env.DB, secret);
  repositories.set(env.DB, { secret, repository });
  return repository;
}

export const requireDevice: MiddlewareHandler<DeviceBindings> = async (
  context,
  next,
) => {
  const authorization = context.req.header("Authorization");
  const bearer = authorization?.match(/^Bearer ([^\s]+)$/i);
  const device = bearer
    ? await identityRepository(context.env).authenticateDevice(bearer[1])
    : null;
  if (!device)
    throw new HTTPException(401, { message: "Device authentication required" });
  context.set("device", device);
  await touchEmployeeActivity(context, device.employeeId, "app");
  await next();
};

/**
 * How an employee-facing router learns who is calling: `authorize` sets the `device` variable (a phone's bearer
 * credential, or the web session's employee) and `apiBase` prefixes the media URLs the router returns.
 */
export interface EmployeeAccess {
  authorize: MiddlewareHandler<DeviceBindings>;
  apiBase: string;
}

export const deviceAccess: EmployeeAccess = { authorize: requireDevice, apiBase: "/v1/device" };

function employeeEmailExists(error: unknown): unknown {
  if (error instanceof EmployeeHierarchyError) return new ApiError(error.status, error.code, error.message);
  if (error instanceof EmployeeEmailExistsError) {
    return new ApiError(409, "employee_email_exists", "Another employee already uses this email");
  }
  if (error instanceof EmployeePhoneExistsError) {
    return new ApiError(409, "employee_phone_exists", "Another active employee already has this phone number");
  }
  return error;
}

const deviceInfo = z.object({
  model: z.string().trim().min(1).max(128).optional(),
  manufacturer: z.string().trim().min(1).max(128).optional(),
  androidVersion: z.string().trim().min(1).max(64).optional(),
  oneUiVersion: z.string().trim().min(1).max(64).optional(),
  appVersion: z.string().trim().min(1).max(64).optional(),
  phoneNumbers: phoneNumbersInput.optional(),
});
const registrationInput = z.object({
  invitationCode: z.string().min(1).max(256),
  device: deviceInfo,
});
const heartbeatInput = z.object({
  appVersion: z.string().trim().min(1).max(64),
  pendingUploads: nonnegativeInteger,
  lastSuccessfulUploadAt: utcTimestamp.optional(),
  deviceId: id.optional(),
  phoneNumbers: phoneNumbersInput.optional(),
});
const employeeEmail = z.string().trim().max(254).nullable().optional();
const employeeInput = z.object({
  name: z.string().trim().min(1).max(200),
  phoneNumber: z.string().trim().min(1).max(64).optional(),
  email: employeeEmail,
  role: z.enum(["employee", "manager"]).optional(),
  managerId: id.nullable().optional(),
  notifyTeamMessages: z.boolean().optional(),
});
const employeePatchInput = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  phoneNumber: z.string().trim().min(1).max(64).nullable().optional(),
  email: employeeEmail,
  role: z.enum(["employee", "manager"]).optional(),
  managerId: id.nullable().optional(),
  notifyTeamMessages: z.boolean().optional(),
  moveTeamTo: id.nullable().optional(),
});

const directoryQuery = z.strictObject({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .optional(),
});
const revocableDirectoryQuery = directoryQuery.extend({
  includeRevoked: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
});

function encodeCursor(cursor: z.infer<typeof directoryCursor>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeCursor(encoded: string) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const bytes = Uint8Array.from(
      atob(encoded.replaceAll("-", "+").replaceAll("_", "/")),
      (character) => character.charCodeAt(0),
    );
    const cursor = directoryCursor.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (encodeCursor(cursor) !== encoded) throw new Error();
    return cursor;
  } catch {
    throw new HTTPException(400, { message: "Invalid pagination cursor" });
  }
}

function queryValues(url: string) {
  const values: Record<string, string> = Object.create(null);
  for (const [key, value] of new URL(url).searchParams) {
    if (Object.hasOwn(values, key))
      throw new HTTPException(400, { message: "Invalid query parameters" });
    values[key] = value;
  }
  for (const key of Object.keys(values)) {
    if (values[key] === "") delete values[key];
  }
  return values;
}

function pageDto<T>(page: {
  items: T[];
  nextCursor: z.infer<typeof directoryCursor> | null;
}) {
  return {
    items: page.items,
    nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
  };
}

export function createDeviceIdentityRoutes() {
  const app = new Hono<DeviceBindings>();
  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  app.post("/register", async (context) => {
    const input = registrationInput.parse(await context.req.json());
    const registered = await identityRepository(context.env).redeemInvitation(
      input.invitationCode,
      input.device,
    );
    if (!registered)
      throw new HTTPException(401, {
        message: "Invitation is invalid or expired",
      });
    await recordActivity(context, {
      actor: { type: "employee", id: registered.employee.id, name: registered.employee.name }, channel: "app",
      category: "device", action: "enrolled", target: { type: "device", id: registered.device.id, label: registered.device.model ?? null },
      details: {
        model: registered.device.model, androidVersion: registered.device.androidVersion,
        appVersion: registered.device.appVersion, recovered: registered.device.invitationId !== registered.device.lastInvitationId,
      },
    });
    return context.json(
      {
        requestId: context.get("requestId"),
        deviceId: registered.device.id,
        invitationId: registered.device.invitationId,
        lastInvitationId: registered.device.lastInvitationId,
        employee: registered.employee,
        deviceToken: registered.deviceToken,
      },
      201,
    );
  });
  app.post("/heartbeat", requireDevice, async (context) => {
    const input = heartbeatInput.parse(await context.req.json());
    const previousVersion = context.get("device").appVersion;
    const updated = await identityRepository(context.env).recordHeartbeat(
      context.get("device").id,
      input,
    );
    if (!updated)
      throw new HTTPException(401, {
        message: "Device authentication required",
      });
    // Heartbeats themselves are not logged; only a changed app version is.
    if (previousVersion && previousVersion !== input.appVersion) {
      await recordActivity(context, {
        ...requestActor(context), category: "device", action: "app_version_changed",
        target: { type: "device", id: updated.id, label: updated.model ?? null }, details: { from: previousVersion, to: input.appVersion },
      });
    }
    return context.json({
      requestId: context.get("requestId"),
      serverTime: updated.lastSeenAt!,
      deviceId: updated.id,
      invitationId: updated.invitationId,
      lastInvitationId: updated.lastInvitationId,
      employee: updated.employee,
    });
  });
  return app;
}

/** A required guard prevents this module being mounted with an unprotected default. */
export function createAdminIdentityRoutes(
  authorize: MiddlewareHandler<AppBindings>,
) {
  const app = new Hono<AppBindings>();
  app.use("*", authorize);
  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/employees", async (context) => {
    const query = directoryQuery.parse(queryValues(context.req.url));
    const page = await identityRepository(context.env).listEmployees({
      ...query,
      cursor: query.cursor ? decodeCursor(query.cursor) : undefined,
    });
    return context.json({
      requestId: context.get("requestId"),
      ...pageDto(page),
    });
  });
  app.patch("/employees/:employeeId", async (context) => {
    const input = employeePatchInput.parse(await context.req.json());
    const repository = identityRepository(context.env);
    const before = await repository.getEmployee(context.req.param("employeeId"));
    const reportsBefore = before?.role === "manager" ? await repository.listReports(before.id) : [];
    const employee = await repository
      .updateEmployee(context.req.param("employeeId"), input)
      .catch((error: unknown) => { throw employeeEmailExists(error); });
    if (!employee)
      throw new HTTPException(404, { message: "Employee not found" });
    // Field names only: the new name, phone number and email never enter the log.
    const fields = [
      ...(before && before.name !== employee.name ? ["name"] : []),
      ...(before && before.phoneNumber !== employee.phoneNumber ? ["phone"] : []),
      ...(before && before.email !== employee.email ? ["email"] : []),
      ...(before && before.notifyTeamMessages !== employee.notifyTeamMessages ? ["notifyTeamMessages"] : []),
    ];
    const who = requestActor(context);
    const target = { type: "employee" as const, id: employee.id, label: employee.name };
    if (fields.length > 0) {
      await recordActivity(context, { ...who, category: "admin", action: "employee_updated", target, details: { fields } });
    }
    if (before && before.role !== employee.role) {
      await recordActivity(context, { ...who, category: "admin", action: "role_changed", target, details: { from: before.role, to: employee.role } });
    }
    if (before && before.managerId !== employee.managerId) {
      await recordActivity(context, {
        ...who, category: "admin", action: "manager_changed", target,
        details: { from: before.managerName ?? "none", to: employee.managerName ?? "none" },
      });
    }
    if (before && before.role === "manager" && employee.role === "employee") {
      // The reports of a demoted manager either moved to another manager or were detached.
      const destination = input.moveTeamTo ? await repository.getEmployee(input.moveTeamTo) : null;
      const moved = reportsBefore.filter((report) => report.active && destination);
      for (const report of moved) {
        await recordActivity(context, {
          ...who, category: "admin", action: "manager_changed", target: { type: "employee", id: report.id, label: report.name },
          details: { from: before.name, to: destination?.name ?? "none" },
        });
      }
      const detached = reportsBefore.filter((report) => !destination || !report.active);
      if (detached.length > 0) {
        await recordActivity(context, {
          ...who, category: "admin", action: "team_detached", target,
          details: { count: detached.length, employees: detached.map((report) => report.name), reason: "demoted" },
        });
      }
    }
    return context.json({ requestId: context.get("requestId"), employee });
  });
  app.delete("/employees/:employeeId/web-sessions", async (context) => {
    const repository = identityRepository(context.env);
    const employeeId = context.req.param("employeeId");
    if (!(await repository.getEmployee(employeeId)))
      throw new HTTPException(404, { message: "Employee not found" });
    const revoked = await repository.revokeWebSessions(employeeId);
    if (revoked > 0) {
      await recordActivity(context, {
        ...requestActor(context), category: "signin", action: "session_revoked",
        target: { type: "employee", id: employeeId }, details: { count: revoked },
      });
    }
    return context.json({ requestId: context.get("requestId"), employeeId, revoked });
  });
  app.get("/devices", async (context) => {
    const query = revocableDirectoryQuery
      .extend({ employeeId: id.optional() })
      .parse(queryValues(context.req.url));
    const page = await identityRepository(context.env).listDevices({
      ...query,
      cursor: query.cursor ? decodeCursor(query.cursor) : undefined,
    });
    return context.json({
      requestId: context.get("requestId"),
      ...pageDto(page),
    });
  });
  app.patch("/devices/:deviceId", async (context) => {
    const input = z
      .strictObject({ employeeId: id })
      .parse(await context.req.json());
    const repository = identityRepository(context.env);
    const device = await repository.reassignDevice(
      context.req.param("deviceId"),
      input.employeeId,
    );
    if (!device) {
      if (!(await repository.getDevice(context.req.param("deviceId"))))
        throw new HTTPException(404, { message: "Device not found" });
      throw new HTTPException(409, {
        message: "Device must be live and the employee active",
      });
    }
    await recordActivity(context, {
      ...requestActor(context), category: "device", action: "reassigned",
      target: { type: "device", id: device.id, label: device.model ?? null }, details: { toEmployee: device.employee.name },
    });
    return context.json({ requestId: context.get("requestId"), device });
  });
  app.post("/devices/:deviceId/revoke", async (context) => {
    const repository = identityRepository(context.env);
    if (!(await repository.revokeDevice(context.req.param("deviceId"))))
      throw new HTTPException(404, { message: "Device not found" });
    const device = await repository.getManagedDevice(
      context.req.param("deviceId"),
    );
    await recordActivity(context, {
      ...requestActor(context), category: "device", action: "revoked",
      target: { type: "device", id: context.req.param("deviceId"), label: device?.model ?? null },
    });
    return context.json({ requestId: context.get("requestId"), device });
  });
  app.post("/devices/:deviceId/recovery-invitations", async (context) => {
    const repository = identityRepository(context.env);
    const invitation = await repository.createRecoveryInvitation(
      context.req.param("deviceId"),
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    );
    if (!invitation) {
      if (!(await repository.getDevice(context.req.param("deviceId"))))
        throw new HTTPException(404, { message: "Device not found" });
      throw new HTTPException(409, { message: "Device must be live and the employee active" });
    }
    await recordActivity(context, {
      ...requestActor(context), category: "device", action: "recovery_invited",
      target: { type: "device", id: context.req.param("deviceId") },
    });
    return context.json({
      requestId: context.get("requestId"),
      invitationCode: invitation.invitationCode,
      invitationId: invitation.id,
      expiresAt: invitation.expiresAt,
      ...enrollmentQr(new URL(context.req.url).origin, invitation.invitationCode),
    }, 201);
  });
  app.get("/employees/:employeeId/invitations", async (context) => {
    const query = revocableDirectoryQuery.parse(queryValues(context.req.url));
    const repository = identityRepository(context.env);
    if (!(await repository.getEmployee(context.req.param("employeeId"))))
      throw new HTTPException(404, { message: "Employee not found" });
    const page = await repository.listInvitations(
      context.req.param("employeeId"),
      {
        ...query,
        cursor: query.cursor ? decodeCursor(query.cursor) : undefined,
      },
    );
    return context.json({
      requestId: context.get("requestId"),
      ...pageDto(page),
    });
  });
  app.post(
    "/employees/:employeeId/invitations/:invitationId/revoke",
    async (context) => {
      const invitation = await identityRepository(context.env).revokeInvitation(
        context.req.param("employeeId"),
        context.req.param("invitationId"),
      );
      if (!invitation)
        throw new HTTPException(404, { message: "Invitation not found" });
      await recordActivity(context, {
        ...requestActor(context), category: "device", action: "invitation_revoked",
        target: { type: "employee", id: context.req.param("employeeId") },
      });
      return context.json({ requestId: context.get("requestId"), invitation });
    },
  );
  app.post("/employees", async (context) => {
    const input = employeeInput.parse(await context.req.json());
    const employee = await identityRepository(context.env)
      .createEmployee(input)
      .catch((error: unknown) => { throw employeeEmailExists(error); });
    const who = requestActor(context);
    const target = { type: "employee" as const, id: employee.id, label: employee.name };
    await recordActivity(context, { ...who, category: "admin", action: "employee_created", target });
    if (employee.role === "manager") {
      await recordActivity(context, { ...who, category: "admin", action: "role_changed", target, details: { from: "employee", to: "manager" } });
    }
    if (employee.managerId) {
      await recordActivity(context, {
        ...who, category: "admin", action: "manager_changed", target,
        details: { from: "none", to: employee.managerName ?? "none" },
      });
    }
    return context.json(
      {
        requestId: context.get("requestId"),
        employee,
      },
      201,
    );
  });
  app.post("/employees/:employeeId/invitations", async (context) => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const invitation = await identityRepository(context.env).createInvitation(
      context.req.param("employeeId"),
      expiresAt,
    );
    if (!invitation)
      throw new HTTPException(404, { message: "Active employee not found" });
    await recordActivity(context, {
      ...requestActor(context), category: "device", action: "invitation_created",
      target: { type: "employee", id: context.req.param("employeeId") },
    });
    return context.json(
      {
        requestId: context.get("requestId"),
        invitationCode: invitation.invitationCode,
        invitationId: invitation.id,
        expiresAt: invitation.expiresAt,
        ...enrollmentQr(new URL(context.req.url).origin, invitation.invitationCode),
      },
      201,
    );
  });
  return app;
}
