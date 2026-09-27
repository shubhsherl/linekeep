import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { AppBindings } from "../../app";
import {
  createIdentityRepository,
  directoryCursor,
  phoneNumbersInput,
  type Device,
  type IdentityRepository,
} from "../../data/identity";
import { id, nonnegativeInteger, utcTimestamp } from "../../data/values";
import type { Env } from "../../env";

export type DeviceBindings = AppBindings & {
  Variables: AppBindings["Variables"] & { device: Device };
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
  await next();
};

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
const employeeInput = z.object({
  name: z.string().trim().min(1).max(200),
  phoneNumber: z.string().trim().min(1).max(64).optional(),
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
    const updated = await identityRepository(context.env).recordHeartbeat(
      context.get("device").id,
      input,
    );
    if (!updated)
      throw new HTTPException(401, {
        message: "Device authentication required",
      });
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
    const input = employeeInput
      .pick({ name: true })
      .strict()
      .parse(await context.req.json());
    const employee = await identityRepository(context.env).updateEmployee(
      context.req.param("employeeId"),
      input,
    );
    if (!employee)
      throw new HTTPException(404, { message: "Employee not found" });
    return context.json({ requestId: context.get("requestId"), employee });
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
    return context.json({ requestId: context.get("requestId"), device });
  });
  app.post("/devices/:deviceId/revoke", async (context) => {
    const repository = identityRepository(context.env);
    if (!(await repository.revokeDevice(context.req.param("deviceId"))))
      throw new HTTPException(404, { message: "Device not found" });
    const device = await repository.getManagedDevice(
      context.req.param("deviceId"),
    );
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
    return context.json({
      requestId: context.get("requestId"),
      invitationCode: invitation.invitationCode,
      invitationId: invitation.id,
      expiresAt: invitation.expiresAt,
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
      return context.json({ requestId: context.get("requestId"), invitation });
    },
  );
  app.post("/employees", async (context) => {
    const input = employeeInput.parse(await context.req.json());
    const employee = await identityRepository(context.env).createEmployee(
      input,
    );
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
    return context.json(
      {
        requestId: context.get("requestId"),
        invitationCode: invitation.invitationCode,
        invitationId: invitation.id,
        expiresAt: invitation.expiresAt,
      },
      201,
    );
  });
  return app;
}
