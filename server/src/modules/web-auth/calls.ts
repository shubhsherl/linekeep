import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { recordActivity, requestActor } from "../../activity/record";
import { callTarget } from "../../activity/targets";
import { callPhoneKey, createCustomerRepository } from "../../data/customers";
import { createEmployeeCallRepository } from "../../data/employee-calls";
import { requireFeature } from "../../settings/gate";
import { decodeCursor, encodeCursor, playbackAuthorized, playbackCapability, queryValues, serveRecordingAudio } from "../admin-calls";
import type { DeviceBindings, EmployeeAccess } from "../identity";
import { employeeScope, narrowEmployees, takeQueryValue } from "../identity/scope";
import type { WebBindings } from "./session";

const callId = z.string().min(1).max(256);
const customerId = z.string().min(1).max(256);
const pageQuery = z.strictObject({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
});

/**
 * Listening to recordings: a short-lived signed URL, like the administrator's playback. An employee can play their
 * own calls; a manager also their team's. Deleting stays with administrators. Anything outside the scope is a 404.
 * On the phone API only managers get these routes (an employee's app has no playback).
 */
export function createCallPlaybackRoutes(access: EmployeeAccess, managersOnly: boolean) {
  const routes = new Hono<DeviceBindings>();
  const scopeOf = async (context: Context<DeviceBindings>) => {
    const scope = await employeeScope(context);
    if (managersOnly && scope.role !== "manager") throw new HTTPException(404, { message: "Recording not found" });
    return scope.employeeIds;
  };
  if (managersOnly) {
    for (const path of ["/call-history/:callId/recording", "/call-history/:callId/recording/audio"]) {
      routes.use(path, access.authorize);
    }
  }

  routes.get("/call-history/:callId/recording", async (context) => {
    const recording = await createEmployeeCallRepository(context.env.DB).recordingFor(
      await scopeOf(context), callId.parse(context.req.param("callId")),
    );
    if (!recording || !(await context.env.RECORDINGS.head(recording.objectKey))) {
      throw new HTTPException(404, { message: "Recording not found" });
    }
    const audioUrl = new URL(context.req.url);
    audioUrl.pathname = `${audioUrl.pathname}/audio`;
    const { url, expiresAt } = await playbackCapability(context.env.TOKEN_HASH_SECRET, recording.objectKey, audioUrl);
    const logId = callId.parse(context.req.param("callId"));
    const entry = await context.env.DB.prepare("SELECT remote_number FROM call_logs WHERE id = ?").bind(logId).first<{ remote_number: string | null }>();
    await recordActivity(context, {
      ...requestActor(context), category: "call", action: "recording_played",
      target: await callTarget(context.env.DB, logId, entry?.remote_number), details: { callId: logId },
    });
    return context.json({ requestId: context.get("requestId"), url, expiresAt, contentType: recording.contentType });
  });

  // The capability proves the URL came from the playback call; the session and the scope check still apply.
  routes.on(["GET", "HEAD"], "/call-history/:callId/recording/audio", async (context) => {
    const recording = await createEmployeeCallRepository(context.env.DB).recordingFor(
      await scopeOf(context), callId.parse(context.req.param("callId")),
    );
    if (!recording) throw new HTTPException(404, { message: "Recording not found" });
    const authorized = await playbackAuthorized(context.env.TOKEN_HASH_SECRET, recording.objectKey, context.req.url);
    if (!authorized) throw new HTTPException(401, { message: "Invalid or expired playback capability" });
    return serveRecordingAudio(context, recording, authorized.download);
  });
  return routes;
}

/**
 * The web app's call extras beyond what the phone app has: the calls with one of the customers the employee can
 * see (a manager: including the team's, narrowed by `employeeId`), and recording playback.
 */
export function createWebCallRoutes(access: EmployeeAccess) {
  const routes = new Hono<WebBindings>();

  routes.get("/customers/:customerId/calls", requireFeature("customers"), async (context) => {
    const scope = await employeeScope(context);
    const calls = narrowEmployees(scope, new URL(context.req.url).searchParams.get("employeeId") || undefined);
    const customer = await createCustomerRepository(context.env.DB).getCustomer(
      customerId.parse(context.req.param("customerId")), { employeeIds: scope.employeeIds },
    );
    if (!customer) throw new HTTPException(404, { message: "Customer not found" });
    const { cursor, limit } = pageQuery.parse(takeQueryValue(queryValues(context.req.url, true), "employeeId").rest);
    const phoneKey = callPhoneKey(customer.phone);
    const page = phoneKey
      ? await createEmployeeCallRepository(context.env.DB).list(calls, {
        phoneKey, limit, cursor: cursor ? decodeCursor(cursor) : undefined,
      }, scope.employeeIds)
      : { items: [], nextCursor: null };
    return context.json({
      requestId: context.get("requestId"),
      items: page.items,
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
    });
  });

  routes.route("/", createCallPlaybackRoutes(access, false));
  return routes;
}
