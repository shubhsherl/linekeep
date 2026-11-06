import { Hono } from "hono";
import { z } from "zod";

import { createPushRepository } from "../../data/push";
import { pushClientConfig } from "../../push/client-config";
import { requireDevice, type DeviceBindings } from "../identity";

const registration = z.strictObject({ token: z.string().min(20).max(4096) });

/** Mount at /v1/device. A phone registers its FCM token so the server can notify its employee. */
export function createDevicePushRoutes() {
  const routes = new Hono<DeviceBindings>();
  routes.get("/push-config", requireDevice, (context) => {
    context.header("Cache-Control", "no-store");
    return context.json({ requestId: context.get("requestId"), push: pushClientConfig(context.env.FIREBASE_CLIENT_CONFIG) });
  });
  routes.put("/push-token", requireDevice, async (context) => {
    const { token } = registration.parse(await context.req.json());
    await createPushRepository(context.env.DB).setToken(context.get("device").id, token);
    return context.json({ requestId: context.get("requestId"), status: "registered" });
  });
  routes.delete("/push-token", requireDevice, async (context) => {
    await createPushRepository(context.env.DB).clearToken(context.get("device").id);
    return context.json({ requestId: context.get("requestId"), status: "removed" });
  });
  return routes;
}
