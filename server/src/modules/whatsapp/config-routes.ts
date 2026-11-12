import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { recordActivity, requestActor } from "../../activity/record";
import type { AppBindings } from "../../app";
import {
  ConfigLimitError, ConfigOrderError, autoReplyCreate, autoReplyUpdate, createWhatsAppConfigRepository,
  quickMessageCreate, quickMessageUpdate,
} from "../../data/whatsapp-config";
import { deviceAccess, type DeviceBindings, type EmployeeAccess } from "../identity";

const id = z.string().min(1).max(256);
const reorderInput = z.strictObject({ ids: z.array(id).max(100) });
const activityQuery = z.strictObject({ limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional() });

function limitError(context: { get(key: "requestId"): string; json: (body: unknown, status: 409) => Response }, what: string) {
  return context.json({ requestId: context.get("requestId"), error: { code: "LIMIT_REACHED", message: `Too many ${what}; delete one first` } }, 409);
}

/** Mount at /v1/admin. Rules and quick messages live in the dashboard's Config tab. */
export function createAdminWhatsAppConfigRoutes(authorize: MiddlewareHandler<AppBindings>) {
  const routes = new Hono<AppBindings>();
  for (const path of ["/whatsapp/auto-replies", "/whatsapp/auto-replies/*", "/whatsapp/quick-messages", "/whatsapp/quick-messages/*"]) {
    routes.use(path, async (context, next) => {
      context.header("Cache-Control", "private, no-store");
      await next();
    }, authorize);
  }
  const repository = (db: D1Database) => createWhatsAppConfigRepository(db);
  const changed = (context: Parameters<typeof requestActor>[0], action: "auto_replies_changed" | "quick_messages_changed", change: string) =>
    recordActivity(context, { ...requestActor(context), category: "admin", action, details: { change } });

  routes.get("/whatsapp/auto-replies", async (context) =>
    context.json({ requestId: context.get("requestId"), items: await repository(context.env.DB).listRules() }));
  routes.get("/whatsapp/auto-replies/activity", async (context) => {
    const query = activityQuery.parse(Object.fromEntries(new URL(context.req.url).searchParams));
    return context.json({ requestId: context.get("requestId"), items: await repository(context.env.DB).activity(query.limit ?? 20) });
  });
  routes.post("/whatsapp/auto-replies/reorder", async (context) => {
    try {
      const { ids } = reorderInput.parse(await context.req.json());
      const items = await repository(context.env.DB).reorderRules(ids);
      await changed(context, "auto_replies_changed", "reordered");
      return context.json({ requestId: context.get("requestId"), items });
    } catch (error) {
      if (error instanceof ConfigOrderError) throw new HTTPException(400, { message: "ids must list every rule exactly once" });
      throw error;
    }
  });
  routes.post("/whatsapp/auto-replies", async (context) => {
    try {
      const created = await repository(context.env.DB).createRule(autoReplyCreate.parse(await context.req.json()));
      await changed(context, "auto_replies_changed", "created");
      return context.json({ requestId: context.get("requestId"), rule: created }, 201);
    } catch (error) {
      if (error instanceof ConfigLimitError) return limitError(context, "rules");
      throw error;
    }
  });
  routes.patch("/whatsapp/auto-replies/:ruleId", async (context) => {
    const updated = await repository(context.env.DB).updateRule(id.parse(context.req.param("ruleId")), autoReplyUpdate.parse(await context.req.json()));
    if (!updated) throw new HTTPException(404, { message: "Rule not found" });
    await changed(context, "auto_replies_changed", "updated");
    return context.json({ requestId: context.get("requestId"), rule: updated });
  });
  routes.delete("/whatsapp/auto-replies/:ruleId", async (context) => {
    await repository(context.env.DB).deleteRule(id.parse(context.req.param("ruleId")));
    await changed(context, "auto_replies_changed", "deleted");
    return context.json({ requestId: context.get("requestId"), status: "deleted" });
  });

  routes.get("/whatsapp/quick-messages", async (context) =>
    context.json({ requestId: context.get("requestId"), items: await repository(context.env.DB).listQuickMessages() }));
  routes.post("/whatsapp/quick-messages", async (context) => {
    try {
      const created = await repository(context.env.DB).createQuickMessage(quickMessageCreate.parse(await context.req.json()));
      await changed(context, "quick_messages_changed", "created");
      return context.json({ requestId: context.get("requestId"), message: created }, 201);
    } catch (error) {
      if (error instanceof ConfigLimitError) return limitError(context, "quick messages");
      throw error;
    }
  });
  routes.patch("/whatsapp/quick-messages/:messageId", async (context) => {
    const updated = await repository(context.env.DB).updateQuickMessage(id.parse(context.req.param("messageId")), quickMessageUpdate.parse(await context.req.json()));
    if (!updated) throw new HTTPException(404, { message: "Quick message not found" });
    await changed(context, "quick_messages_changed", "updated");
    return context.json({ requestId: context.get("requestId"), message: updated });
  });
  routes.delete("/whatsapp/quick-messages/:messageId", async (context) => {
    await repository(context.env.DB).deleteQuickMessage(id.parse(context.req.param("messageId")));
    await changed(context, "quick_messages_changed", "deleted");
    return context.json({ requestId: context.get("requestId"), status: "deleted" });
  });
  return routes;
}

/** Mount at /v1/device (or /v1/web): employees read the shared quick messages. */
export function createDeviceWhatsAppConfigRoutes(access: EmployeeAccess = deviceAccess) {
  const routes = new Hono<DeviceBindings>();
  routes.get("/whatsapp/quick-messages", access.authorize, async (context) => {
    context.header("Cache-Control", "no-store");
    return context.json({ requestId: context.get("requestId"), items: await createWhatsAppConfigRepository(context.env.DB).listQuickMessages() });
  });
  return routes;
}
