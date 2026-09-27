import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";

import {
  createAdminIdentityRoutes,
  createDeviceIdentityRoutes,
  type DeviceBindings,
} from "./index";

/** Feature fixture only: production Access validation is exercised by HTTP integration tests. */
export function createIdentityTestApp() {
  const app = new Hono<DeviceBindings>();
  app.use("*", async (context, next) => {
    context.set("requestId", `req_${crypto.randomUUID()}`);
    await next();
  });
  app.onError((error, context) => {
    if (error instanceof HTTPException) return error.getResponse();
    return context.json(
      { error: "Invalid test request" },
      error instanceof ZodError ? 400 : 500,
    );
  });
  app.route(
    "/v1/admin",
    createAdminIdentityRoutes(async (context, next) => {
      if (context.req.header("Authorization") !== "Bearer synthetic-admin")
        throw new HTTPException(401);
      await next();
    }),
  );
  app.route("/v1/device", createDeviceIdentityRoutes());
  return app;
}
