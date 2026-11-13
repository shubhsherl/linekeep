import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { deviceAccess, identityRepository, type DeviceBindings, type EmployeeAccess } from "../identity";

import { analyticsQuery, createAnalyticsRepository, emptyMetrics, istDate, type EmployeeAnalytics } from "../../data/analytics";
import { callType } from "../../data/call-history";
import { createEmployeeCallRepository } from "../../data/employee-calls";
import { utcTimestamp, type Clock } from "../../data/values";
import { decodeCursor, encodeCursor, queryValues as callQueryValues } from "../admin-calls";
import { queryValues as analyticsQueryValues } from "../analytics";
import { employeeScope, narrowEmployees, notAManager, outOfScope, profileExtras, takeQueryValue } from "../identity/scope";

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
 * Mount at /v1/device. Call analytics and call history for the signed-in employee, or for a manager their team too:
 * the employee id comes from the device credential, never from the query, the scope is resolved once per request
 * from the database, and the repositories bind it in SQL.
 */
export function createDeviceEmployeeRoutes(clock: Clock = () => new Date(), access: EmployeeAccess = deviceAccess) {
  const routes = new Hono<DeviceBindings>();
  // Path-scoped: this router shares /v1/device with unauthenticated registration.
  for (const path of ["/analytics", "/call-history", "/profile"]) {
    routes.use(path, async (context, next) => {
      context.header("Cache-Control", "no-store");
      await next();
    }, access.authorize);
  }

  routes.get("/profile", async (context) => {
    const employee = await identityRepository(context.env).getEmployee(context.get("device").employeeId);
    if (!employee) throw new HTTPException(401, { message: "Device authentication required" });
    const scope = await employeeScope(context);
    return context.json({
      requestId: context.get("requestId"),
      employee: { id: employee.id, name: employee.name, phoneNumber: employee.phoneNumber ?? null, ...profileExtras(scope) },
    });
  });

  routes.get("/analytics", async (context) => {
    const scope = await employeeScope(context);
    const { rest, value: groupBy } = takeQueryValue(analyticsQueryValues(context.req.url), "groupBy");
    const manager = scope.role === "manager";
    // The manager-only parameters have no meaning for an employee; refuse them rather than silently ignore them.
    if (!manager && (Object.hasOwn(rest, "employeeIds") || groupBy !== undefined)) throw notAManager();
    if (groupBy !== undefined && groupBy !== "employee") throw new HTTPException(400, { message: "Invalid query parameters" });
    const input = analyticsQuery(istDate(clock())).parse(rest);
    if (!manager) {
      const analytics = await createAnalyticsRepository(context.env.DB).calls({ ...input, employeeIds: [scope.selfId] });
      return context.json({ requestId: context.get("requestId"), ...analytics });
    }
    const chosen = input.employeeIds ?? scope.employeeIds;
    if (chosen.some((employeeId) => !scope.employeeIds.includes(employeeId))) throw outOfScope();
    const analytics = await createAnalyticsRepository(context.env.DB).calls({ ...input, employeeIds: chosen });
    // Everyone included is listed (zero-filled when they made no calls); `byEmployee` is the per-person breakdown.
    const withCalls = new Map(analytics.employees.map((employee) => [employee.id, employee]));
    const employees: EmployeeAnalytics[] = chosen.map((employeeId) => withCalls.get(employeeId)
      ?? { ...emptyMetrics(), id: employeeId, name: scope.names.get(employeeId) ?? "" })
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return context.json({
      requestId: context.get("requestId"), ...analytics, employees,
      ...(groupBy === "employee" ? { byEmployee: analytics.employees } : {}),
    });
  });

  routes.get("/call-history", async (context) => {
    const scope = await employeeScope(context);
    const { rest, value: filter } = takeQueryValue(callQueryValues(context.req.url, true), "employeeId");
    const { cursor, limit, ...filters } = callHistoryQuery.parse(rest);
    const page = await createEmployeeCallRepository(context.env.DB).list(narrowEmployees(scope, filter), {
      ...filters, limit, cursor: cursor ? decodeCursor(cursor) : undefined,
    }, scope.employeeIds);
    return context.json({
      requestId: context.get("requestId"),
      items: page.items,
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
    });
  });
  return routes;
}
