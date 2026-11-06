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
import { createWhatsAppWebhookRoutes } from "./modules/whatsapp";
import { createDevicePushRoutes } from "./modules/push";
import { createAdminWhatsAppMediaRoutes, createDeviceWhatsAppMediaRoutes } from "./modules/whatsapp/media";
import { createAdminWhatsAppConfigRoutes, createDeviceWhatsAppConfigRoutes } from "./modules/whatsapp/config-routes";

import { createAdminSettingsRoutes } from "./modules/settings";
import { createAdminAppRoutes, createPublicDownloadRoutes } from "./modules/app-release";
import type { Env } from "./env";
import type { Features } from "./settings/fields";
import { applySettings, loadSettings, resolveFeatures } from "./settings/service";

export type AppBindings = {
  Bindings: Env & { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUDIENCE?: string };
  Variables: {
    requestId: string;
    adminAuthorized?: boolean;
    adminId?: string;
    /** The deployment's own variables, before dashboard settings are laid over `context.env`. */
    deploymentEnv?: Env;
    features?: Features;
  };
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
    // A request that declares an empty body (a browser or phone POSTing with no payload) has nothing to type-check.
    if (
      context.req.raw.body &&
      context.req.header("Content-Length") !== "0" &&
      context.req.header("Content-Type")?.split(";")[0].trim() !==
        "application/json"
    ) {
      throw new HTTPException(400, { message: "JSON request body required" });
    }
    const limit =
      context.req.method === "POST" &&
      (context.req.path === "/v1/device/call-logs/batch" || context.req.path === "/v1/webhooks/whatsapp")
        ? limitCallHistoryBody
        : limitJsonBody;
    return limit(context, next);
  });
  // Dashboard settings (database first, then deployment variables) become `context.env`, so every module keeps
  // reading WHATSAPP_*, FCM_*, MAILGUN_* … as before. One cached lookup per request. Uploads and call-log
  // batches read none of these settings, so the highest-volume device paths skip it.
  app.use("/v1/*", async (context, next) => {
    if (context.req.path.startsWith("/v1/device/uploads/") || context.req.path.startsWith("/v1/device/call-logs")) return next();
    const deployment = context.env;
    const snapshot = await loadSettings(deployment);
    context.set("deploymentEnv", deployment);
    context.set("features", resolveFeatures(deployment, snapshot));
    context.env = applySettings(deployment, snapshot);
    return next();
  });
  app.route("/v1/webhooks", createWhatsAppWebhookRoutes());
  app.route("/v1/device", createDeviceIdentityRoutes());
  app.route("/v1/device/uploads", createRecordingRoutes());
  app.route("/v1/device/call-logs", createDeviceCallHistoryRoutes());
  app.route("/v1/device", createDeviceCustomerRoutes());
  app.route("/v1/device", createDeviceWhatsAppConfigRoutes());
  app.route("/v1/device", createDeviceWhatsAppMediaRoutes());
  app.route("/v1/device", createDevicePushRoutes());
  app.route("/v1/admin", createAdminIdentityRoutes(requireAdmin));
  app.route("/v1/admin", createAdminCallRoutes(requireAdmin));
  app.route("/v1/admin", createAdminCallHistoryRoutes(requireAdmin));
  app.route("/v1/admin", createAdminCustomerRoutes(requireAdmin));
  app.route("/v1/admin", createAdminWhatsAppConfigRoutes(requireAdmin));
  app.route("/v1/admin", createAdminWhatsAppMediaRoutes(requireAdmin));
  app.route("/v1/admin", createAdminAnalyticsRoutes(requireAdmin));
  app.route("/v1/admin", createAdminSettingsRoutes(requireAdmin));
  app.route("/v1/admin", createAdminAppRoutes(requireAdmin));
  app.route("/", createPublicDownloadRoutes());
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
