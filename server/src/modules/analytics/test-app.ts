import { Hono } from "hono";

import type { AppBindings } from "../../app";
import { handleError } from "../../http/errors";
import { createAdminAnalyticsRoutes } from "./index";

// Bundled with the routes so error handling shares their zod identity; the injectable
// clock pins "today" for the default-range tests.
export function createAnalyticsTestApp(now: string) {
  const app = new Hono<AppBindings>();
  app.onError(handleError);
  app.use("*", async (context, next) => {
    context.set("requestId", "req_analytics_test");
    await next();
  });
  app.route("/v1/admin", createAdminAnalyticsRoutes(async (_context, next) => next(), () => new Date(now)));
  return app;
}
