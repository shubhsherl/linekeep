import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";

import type { AppBindings } from "../../app";
import { createAdminCallRoutes } from "./index";

// Bundle the harness and routes together so Hono shares its default error-handler identity.
export function createAdminCallTestApp() {
  const app = new Hono<AppBindings>();
  app.use("*", async (context, next) => {
    context.set("requestId", "req_admin_test");
    await next();
  });
  // Production identity enforcement is supplied separately at application integration.
  const authorize: MiddlewareHandler<AppBindings> = async (context, next) => {
    if (context.req.header("Authorization") !== "Bearer synthetic-admin") {
      return context.json(
        {
          requestId: context.get("requestId"),
          error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        },
        401,
      );
    }
    await next();
  };
  app.route("/v1/admin", createAdminCallRoutes(authorize));
  app.onError((error, context) =>
    context.json(
      {
        requestId: context.get("requestId"),
        error: { message: "Request failed" },
      },
      error instanceof ZodError
        ? 400
        : error instanceof HTTPException
          ? error.status
          : 500,
    ),
  );
  return app;
}
