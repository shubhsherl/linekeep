import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { AppBindings } from "../../app";
import {
  CallHistoryAuthorizationError,
  CallHistoryConflictError,
  callHistoryBatchInput,
  callHistoryCursor,
  callType,
  createCallHistoryRepository,
  type CallHistoryCursor,
} from "../../data/call-history";
import { utcTimestamp } from "../../data/values";
import { requireDevice, type DeviceBindings } from "../identity";

const listInput = z.strictObject({
  employeeId: z.string().min(1).max(256).optional(),
  callType: callType.optional(),
  number: z.string().max(256).optional(),
  from: utcTimestamp.optional(),
  to: utcTimestamp.optional(),
  hasRecording: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number)
    .pipe(z.number().int().min(1).max(100)).optional(),
}).refine((value) => !value.from || !value.to || value.from <= value.to);

function queryValues(url: string) {
  const values: Record<string, string> = Object.create(null);
  for (const [key, value] of new URL(url).searchParams) {
    if (Object.hasOwn(values, key)) {
      throw new HTTPException(400, { message: "Invalid query parameters" });
    }
    values[key] = value;
  }
  for (const key of Object.keys(values)) {
    if (values[key] === "") delete values[key];
  }
  return values;
}

function encodeCursor(cursor: CallHistoryCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(encoded: string): CallHistoryCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const bytes = Uint8Array.from(
      atob(encoded.replaceAll("-", "+").replaceAll("_", "/")),
      (character) => character.charCodeAt(0),
    );
    const cursor = callHistoryCursor.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (encodeCursor(cursor) !== encoded) throw new Error();
    return cursor;
  } catch {
    throw new HTTPException(400, { message: "Invalid pagination cursor" });
  }
}

/** Mount at /v1/device/call-logs; the bearer credential determines enrollment. */
export function createDeviceCallHistoryRoutes() {
  const routes = new Hono<DeviceBindings>();
  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  routes.use("*", requireDevice);
  routes.post("/batch", async (context) => {
    const input = callHistoryBatchInput.parse(await context.req.json());
    try {
      const accepted = await createCallHistoryRepository(context.env.DB).upsertBatch(
        context.get("device").id, input,
      );
      return context.json({ requestId: context.get("requestId"), accepted });
    } catch (error) {
      if (error instanceof CallHistoryAuthorizationError) {
        throw new HTTPException(401, { message: "Device authentication required" });
      }
      if (error instanceof CallHistoryConflictError) {
        throw new HTTPException(409, { message: "Call history identity conflicts with stored entry" });
      }
      throw error;
    }
  });
  return routes;
}

/** Mount at /v1/admin; callers must supply the existing administrator guard. */
export function createAdminCallHistoryRoutes(authorize: MiddlewareHandler<AppBindings>) {
  if (typeof authorize !== "function") throw new TypeError("Admin authorization is required");
  const routes = new Hono<AppBindings>();
  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "private, no-store");
    context.header("Pragma", "no-cache");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  routes.use("*", authorize);
  routes.get("/call-logs", async (context) => {
    const input = listInput.parse(queryValues(context.req.url));
    const result = await createCallHistoryRepository(context.env.DB).list({
      ...input,
      cursor: input.cursor ? decodeCursor(input.cursor) : undefined,
    });
    return context.json({
      requestId: context.get("requestId"),
      items: result.items,
      nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
    });
  });
  routes.delete("/call-logs/:callLogId", async (context) => {
    const callLogId = z.string().min(1).max(256).parse(context.req.param("callLogId"));
    await createCallHistoryRepository(context.env.DB).markDeleted(callLogId);
    return context.json({
      requestId: context.get("requestId"),
      callLogId,
      status: "deleted",
    });
  });
  return routes;
}
