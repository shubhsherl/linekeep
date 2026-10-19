import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import type { AppBindings } from "../../app";
import { analyticsQuery, createAnalyticsRepository, istDate } from "../../data/analytics";
import type { Clock } from "../../data/values";

function queryValues(url: string) {
  const values: Record<string, string> = Object.create(null);
  for (const [key, value] of new URL(url).searchParams) {
    if (Object.hasOwn(values, key)) {
      throw new HTTPException(400, { message: "Invalid query parameters" });
    }
    values[key] = value;
  }
  for (const key of Object.keys(values)) {
    if (values[key] === "") delete values[key];
  }
  return values;
}

/** Mount at /v1/admin; callers must supply the existing administrator guard. */
export function createAdminAnalyticsRoutes(
  authorize: MiddlewareHandler<AppBindings>,
  clock: Clock = () => new Date(),
) {
  if (typeof authorize !== "function") throw new TypeError("Admin authorization is required");
  const routes = new Hono<AppBindings>();
  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "private, no-store");
    context.header("Pragma", "no-cache");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  routes.use("*", authorize);
  routes.get("/analytics/calls", async (context) => {
    const input = analyticsQuery(istDate(clock())).parse(queryValues(context.req.url));
    const analytics = await createAnalyticsRepository(context.env.DB).calls(input);
    return context.json({ requestId: context.get("requestId"), ...analytics });
  });
  return routes;
}
