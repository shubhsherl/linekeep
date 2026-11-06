import { Hono } from "hono";
import { z } from "zod";

import { createPushRepository } from "../../data/push";
import { requireDevice, type DeviceBindings } from "../identity";

const clientConfig = z.strictObject({
  apiKey: z.string().regex(/^[\w-]{20,100}$/),
  appId: z.string().regex(/^\d+:\d+:android:[0-9a-f]+$/),
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,}$/),
  senderId: z.string().regex(/^\d{5,20}$/),
});

/** The public Firebase identifiers for phones, or null when push is not set up or the setting is malformed. */
export function pushClientConfig(raw: string | undefined) {
  try {
    const parsed = clientConfig.safeParse(raw ? JSON.parse(raw) : null);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

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
