import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { callPhoneKey, createCustomerRepository } from "../../data/customers";
import { createEmployeeCallRepository } from "../../data/employee-calls";
import { requireFeature } from "../../settings/gate";
import { decodeCursor, encodeCursor, playbackAuthorized, playbackCapability, queryValues, serveRecordingAudio } from "../admin-calls";
import type { WebBindings } from "./session";

const callId = z.string().min(1).max(256);
const customerId = z.string().min(1).max(256);
const pageQuery = z.strictObject({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
});

/**
 * Own-only extras of the web app, beyond what the phone app has: the calls with one of the employee's customers,
 * and playback of the employee's own recordings (listening only; deleting stays with administrators). The
 * employee id always comes from the session.
 */
export function createWebCallRoutes() {
  const routes = new Hono<WebBindings>();

  routes.get("/customers/:customerId/calls", requireFeature("customers"), async (context) => {
    const { employeeId } = context.get("device");
    const customer = await createCustomerRepository(context.env.DB).getCustomer(
      customerId.parse(context.req.param("customerId")), { employeeId },
    );
    if (!customer) throw new HTTPException(404, { message: "Customer not found" });
    const { cursor, limit } = pageQuery.parse(queryValues(context.req.url, true));
    const phoneKey = callPhoneKey(customer.phone);
    const page = phoneKey
      ? await createEmployeeCallRepository(context.env.DB).list(employeeId, {
        phoneKey, limit, cursor: cursor ? decodeCursor(cursor) : undefined,
      })
      : { items: [], nextCursor: null };
    return context.json({
      requestId: context.get("requestId"),
      items: page.items,
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
    });
  });

  // A short-lived signed URL, like the administrator's playback; 404 for anything that is not the caller's own recording.
  routes.get("/call-history/:callId/recording", async (context) => {
    const recording = await createEmployeeCallRepository(context.env.DB).recordingFor(
      context.get("device").employeeId, callId.parse(context.req.param("callId")),
    );
    if (!recording || !(await context.env.RECORDINGS.head(recording.objectKey))) {
      throw new HTTPException(404, { message: "Recording not found" });
    }
    const audioUrl = new URL(context.req.url);
    audioUrl.pathname = `${audioUrl.pathname}/audio`;
    const { url, expiresAt } = await playbackCapability(context.env.TOKEN_HASH_SECRET, recording.objectKey, audioUrl);
    return context.json({ requestId: context.get("requestId"), url, expiresAt, contentType: recording.contentType });
  });

  // The capability proves the URL came from the playback call; the session and the ownership check still apply.
  routes.on(["GET", "HEAD"], "/call-history/:callId/recording/audio", async (context) => {
    const recording = await createEmployeeCallRepository(context.env.DB).recordingFor(
      context.get("device").employeeId, callId.parse(context.req.param("callId")),
    );
    if (!recording) throw new HTTPException(404, { message: "Recording not found" });
    const authorized = await playbackAuthorized(context.env.TOKEN_HASH_SECRET, recording.objectKey, context.req.url);
    if (!authorized) throw new HTTPException(401, { message: "Invalid or expired playback capability" });
    return serveRecordingAudio(context, recording, authorized.download);
  });

  return routes;
}
