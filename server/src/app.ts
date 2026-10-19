import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";

import { createAdminUi } from "./admin-ui";
import {
  createLocalAdminRoutes,
  requireAdmin,
  requireAdminPage,
} from "./http/admin-auth";
import { handleError } from "./http/errors";
import {
  createAdminIdentityRoutes,
  createDeviceIdentityRoutes,
} from "./modules/identity";
import { createRecordingRoutes } from "./modules/recordings";
import { createAdminCallRoutes } from "./modules/admin-calls";
import {
  createAdminCallHistoryRoutes,
  createDeviceCallHistoryRoutes,
} from "./modules/call-history";
import {
  createAdminCustomerRoutes,
  createDeviceCustomerRoutes,
} from "./modules/customers";
import { createAdminAnalyticsRoutes } from "./modules/analytics";

import type { Env } from "./env";

export type AppBindings = {
  Bindings: Env & { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUDIENCE?: string };
  Variables: { requestId: string; adminAuthorized?: boolean };
};

export function createApp() {
  const app = new Hono<AppBindings>();

  app.onError(handleError);
  app.use("*", async (context, next) => {
    const startedAt = performance.now();
    const requestId = `req_${crypto.randomUUID()}`;
    context.header("X-Request-Id", requestId);
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    context.set("requestId", requestId);
    await next();
    // Allowlist log fields: never URLs, queries, bodies, headers, tokens, or raw errors.
    console.log(
      JSON.stringify({
        requestId,
        method: /^(GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS)$/.test(
          context.req.method,
        )
          ? context.req.method
          : "OTHER",
        route: context.req.routePath || "unmatched",
        status: context.res.status,
        durationMs: Math.round(performance.now() - startedAt),
      }),
    );
  });

  app.get("/health", (context) =>
    context.json({
      ok: true,
      environment: context.env.ENVIRONMENT,
      requestId: context.get("requestId"),
    }),
  );

  const limitJsonBody = bodyLimit({ maxSize: 16384 });
  const limitCallHistoryBody = bodyLimit({ maxSize: 262144 });
  app.use("/v1/*", async (context, next) => {
    if (context.req.method !== "POST" && context.req.method !== "PATCH")
      return next();
    if (
      context.req.raw.body &&
      context.req.header("Content-Type")?.split(";")[0].trim() !==
        "application/json"
    ) {
      throw new HTTPException(400, { message: "JSON request body required" });
    }
    const limit =
      context.req.method === "POST" &&
      context.req.path === "/v1/device/call-logs/batch"
        ? limitCallHistoryBody
        : limitJsonBody;
    return limit(context, next);
  });
  app.route("/v1/device", createDeviceIdentityRoutes());
  app.route("/v1/device/uploads", createRecordingRoutes());
  app.route("/v1/device/call-logs", createDeviceCallHistoryRoutes());
  app.route("/v1/device", createDeviceCustomerRoutes());
  app.route("/v1/admin", createAdminIdentityRoutes(requireAdmin));
  app.route("/v1/admin", createAdminCallRoutes(requireAdmin));
  app.route("/v1/admin", createAdminCallHistoryRoutes(requireAdmin));
  app.route("/v1/admin", createAdminCustomerRoutes(requireAdmin));
  app.route("/v1/admin", createAdminAnalyticsRoutes(requireAdmin));
  app.route("/", createLocalAdminRoutes());
  app.use("/admin", requireAdminPage);
  app.use("/admin/*", requireAdminPage);
  app.get("/admin/", (context) => context.redirect("/admin", 308));
  app.route("/admin", createAdminUi());

  app.notFound((context) =>
    context.json(
      {
        requestId: context.get("requestId"),
        error: {
          code: "NOT_FOUND",
          message: "Route not found",
        },
      },
      404,
    ),
  );

  return app;
}
