import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { recordActivityBatch, type ActivityEvent } from "../../activity/record";
import type { AppBindings } from "../../app";
import { createWhatsAppRepository } from "../../data/whatsapp";
import { defer } from "../../http/defer";
import { notifyNewMessage } from "../../push/notify";
import { requireFeature } from "../../settings/gate";
import { runAutoReply } from "./auto-reply";
import { storeInboundMedia } from "./media";
import { parseWebhook, verifyWebhookSignature, whatsappConfig } from "../../whatsapp/cloud";

/**
 * Meta's webhook. Mounted outside Cloudflare Access and the admin guard, because Meta cannot sign in; the
 * HMAC over the raw body is the only credential, and nothing is parsed before it verifies.
 */
export function createWhatsAppWebhookRoutes() {
  const routes = new Hono<AppBindings>();
  // A turned-off WhatsApp answers nothing, so Meta cannot verify or deliver to a webhook that should not exist.
  routes.use("*", requireFeature("whatsapp"));
  routes.get("/whatsapp", (context) => {
    const expected = context.env.WHATSAPP_VERIFY_TOKEN?.trim();
    const challenge = context.req.query("hub.challenge");
    if (!expected || context.req.query("hub.mode") !== "subscribe" || context.req.query("hub.verify_token") !== expected
      || !challenge || !/^\d{1,32}$/.test(challenge)) {
      throw new HTTPException(403, { message: "Verification failed" });
    }
    return context.text(challenge);
  });
  routes.post("/whatsapp", async (context) => {
    const secret = context.env.WHATSAPP_APP_SECRET?.trim();
    const config = whatsappConfig(context.env);
    if (!secret || !config) throw new HTTPException(503, { message: "WhatsApp is not configured" });
    const raw = await context.req.text();
    if (!(await verifyWebhookSignature(secret, raw, context.req.header("X-Hub-Signature-256")))) {
      throw new HTTPException(401, { message: "Invalid signature" });
    }
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { throw new HTTPException(400, { message: "Invalid JSON" }); }
    const { inbound, statuses } = parseWebhook(payload, config.phoneNumberId);
    const repository = createWhatsAppRepository(context.env.DB);
    // Any failure answers 5xx so Meta redelivers; every write below is idempotent.
    const replies: Promise<void>[] = [];
    const events: ActivityEvent[] = [];
    for (const message of inbound) {
      const stored = await repository.receive({ ...message, to: null });
      // Only a message stored for the first time can trigger a reply; Meta's redeliveries are inserted as no-ops.
      if (stored?.inserted) {
        const customer = { type: "customer" as const, id: stored.customerId };
        if (stored.customerCreated) {
          events.push({ actor: { type: "customer", id: stored.customerId }, channel: "system", category: "customer", action: "created", target: customer, details: { source: "whatsapp_inbound", ...(stored.assignedTo ? { assigned: 1 } : {}) } });
          if (stored.assignedTo) {
            events.push({ actor: { type: "system" }, channel: "system", category: "customer", action: "assigned", target: customer, details: { employees: [stored.assignedTo.name], auto: true, source: "default_handler" } });
          }
        }
        // The message type only: never its text, the sender's number or the media.
        events.push({ actor: { type: "customer", id: stored.customerId }, channel: "system", category: "whatsapp", action: "message_received", target: customer, details: { type: message.type } });
        replies.push(notifyNewMessage(context.env, stored.customerId));
        if (message.media) replies.push(storeInboundMedia(context.env, stored.messageId).then(() => undefined));
        replies.push(runAutoReply(context.env, { customerId: stored.customerId, externalId: message.externalId, body: message.body, sentAt: message.sentAt }));
      }
    }
    await recordActivityBatch(context, events);
    for (const status of statuses) await repository.applyStatus(status.externalId, status.status, status.at);
    // Reply after answering Meta, which expects a quick 200; without an execution context (tests) wait for it.
    if (replies.length > 0) await defer(context, Promise.all(replies));
    return context.json({ requestId: context.get("requestId"), received: inbound.length, statuses: statuses.length });
  });
  return routes;
}
