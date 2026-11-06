import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { identityRepository, requireDevice, type DeviceBindings } from "../identity";

import { analyticsQuery, createAnalyticsRepository, istDate } from "../../data/analytics";
import { callType } from "../../data/call-history";
import { createEmployeeCallRepository } from "../../data/employee-calls";
import { utcTimestamp, type Clock } from "../../data/values";
import { decodeCursor, encodeCursor, queryValues as callQueryValues } from "../admin-calls";
import { queryValues as analyticsQueryValues } from "../analytics";

const callHistoryQuery = z.strictObject({
  callType: callType.optional(),
  number: z.string().max(256).optional(),
  from: utcTimestamp.optional(),
  to: utcTimestamp.optional(),
  hasRecording: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
}).refine((value) => !value.from || !value.to || value.from <= value.to);

/**
 * Mount at /v1/device. Call analytics and call history for the signed-in employee only: the employee id comes from
 * the device credential, never from the query, and both repositories bind it in SQL.
 */
export function createDeviceEmployeeRoutes(clock: Clock = () => new Date()) {
  const routes = new Hono<DeviceBindings>();
  // Path-scoped: this router shares /v1/device with unauthenticated registration.
  for (const path of ["/analytics", "/call-history", "/profile"]) {
    routes.use(path, async (context, next) => {
      context.header("Cache-Control", "no-store");
      await next();
    }, requireDevice);
  }

  routes.get("/profile", async (context) => {
    const employee = await identityRepository(context.env).getEmployee(context.get("device").employeeId);
    if (!employee) throw new HTTPException(401, { message: "Device authentication required" });
    return context.json({
      requestId: context.get("requestId"),
      employee: { id: employee.id, name: employee.name, phoneNumber: employee.phoneNumber ?? null },
    });
  });

  routes.get("/analytics", async (context) => {
    const query = analyticsQueryValues(context.req.url);
    // The administrator's employee filter has no meaning here; refuse it rather than silently ignore it.
    if (Object.hasOwn(query, "employeeIds")) throw new HTTPException(400, { message: "Invalid query parameters" });
    const input = analyticsQuery(istDate(clock())).parse(query);
    const analytics = await createAnalyticsRepository(context.env.DB).calls({
      ...input, employeeIds: [context.get("device").employeeId],
    });
    return context.json({ requestId: context.get("requestId"), ...analytics });
  });

  routes.get("/call-history", async (context) => {
    const { cursor, limit, ...filters } = callHistoryQuery.parse(callQueryValues(context.req.url, true));
    const page = await createEmployeeCallRepository(context.env.DB).list(context.get("device").employeeId, {
      ...filters, limit, cursor: cursor ? decodeCursor(cursor) : undefined,
    });
    return context.json({
      requestId: context.get("requestId"),
      items: page.items,
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
    });
  });
  return routes;
}
