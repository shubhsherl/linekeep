import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import type { AppBindings } from "../../app";
import {
  activityCsv, activityExportQuery, activityListQuery, createActivityRepository, decodeActivityCursor, encodeActivityCursor,
} from "../../data/activity";

function queryValues(url: string) {
  const values: Record<string, string> = Object.create(null);
  for (const [key, value] of new URL(url).searchParams) {
    if (Object.hasOwn(values, key)) throw new HTTPException(400, { message: "Invalid query parameters" });
    values[key] = value;
  }
  for (const key of Object.keys(values)) {
    if (values[key] === "") delete values[key];
  }
  return values;
}

/** Mount at /v1/admin; callers must supply the existing administrator guard. */
export function createAdminActivityRoutes(authorize: MiddlewareHandler<AppBindings>) {
  if (typeof authorize !== "function") throw new TypeError("Admin authorization is required");
  const routes = new Hono<AppBindings>();
  for (const path of ["/activity", "/activity/*"]) {
    routes.use(path, async (context, next) => {
      context.header("Cache-Control", "private, no-store");
      context.header("Pragma", "no-cache");
      context.header("Referrer-Policy", "no-referrer");
      context.header("X-Content-Type-Options", "nosniff");
      await next();
    }, authorize);
  }

  routes.get("/activity", async (context) => {
    const { cursor, limit, ...filter } = activityListQuery.parse(queryValues(context.req.url));
    const decoded = cursor ? decodeActivityCursor(cursor) : undefined;
    if (cursor && !decoded) throw new HTTPException(400, { message: "Invalid pagination cursor" });
    const page = await createActivityRepository(context.env.DB).list(filter, { cursor: decoded ?? undefined, limit });
    return context.json({
      requestId: context.get("requestId"),
      items: page.items,
      nextCursor: page.nextCursor ? encodeActivityCursor(page.nextCursor) : null,
    });
  });

  routes.get("/activity/export", async (context) => {
    const filter = activityExportQuery.parse(queryValues(context.req.url));
    const { items, truncated } = await createActivityRepository(context.env.DB).export(filter);
    context.header("Content-Type", "text/csv; charset=utf-8");
    context.header("Content-Disposition", `attachment; filename="linekeep-activity-${new Date().toISOString().slice(0, 10)}.csv"`);
    if (truncated) context.header("X-Activity-Truncated", "true");
    return context.body(activityCsv(items));
  });
  return routes;
}
