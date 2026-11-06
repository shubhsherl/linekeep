import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";

import type { AppBindings } from "../../app";
import { type Customer, type WhatsAppMessage, type whatsappSendInput } from "../../data/customers";
import { createWhatsAppRepository } from "../../data/whatsapp";
import type { Env } from "../../env";
import { fetchTemplates, renderTemplate, type WhatsAppTemplate } from "../../whatsapp/templates";
import { defer } from "../../http/defer";
import { notifyNewMessage } from "../../push/notify";
import { runAutoReply } from "./auto-reply";
import { storeInboundMedia } from "./media";
import {
  parseWebhook, sendCloudMessage, verifyWebhookSignature, whatsappConfig, WhatsAppSendError,
} from "../../whatsapp/cloud";

const windowMs = 24 * 60 * 60 * 1000;

/** Approved templates for the admin picker. */
export async function listTemplates(env: Env): Promise<WhatsAppTemplate[]> {
  const config = whatsappConfig(env);
  if (!config?.wabaId) throw new WhatsAppUnavailableError();
  try {
    return await fetchTemplates(config);
  } catch (error) {
    throw new WhatsAppSendFailedError(error instanceof WhatsAppSendError ? error.retryable : true);
  }
}

export function whatsappCanSend(env: Env): boolean {
  return whatsappConfig(env) !== null;
}

export class WhatsAppUnavailableError extends Error {}
/** The 24-hour window is closed (or never opened); only an approved template can be sent. */
export class WhatsAppTemplateRequiredError extends Error {}
export class WhatsAppSendFailedError extends Error {
  constructor(readonly retryable: boolean) { super("WhatsApp message could not be sent"); }
}

/**
 * Sends one message to a customer. The message is stored first, so a failure is visible in the thread and a
 * client retry with the same `clientMessageId` never sends twice.
 */
export async function sendToCustomer(
  env: Env, customer: Customer, input: z.infer<typeof whatsappSendInput>, employeeId: string | null,
): Promise<WhatsAppMessage> {
  const config = whatsappConfig(env);
  if (!config) throw new WhatsAppUnavailableError();
  const repository = createWhatsAppRepository(env.DB);
  const id = `wam_${input.clientMessageId}`;
  const existing = await repository.get(id);
  if (existing) {
    if (existing.customerId !== customer.id) throw new HTTPException(409, { message: "Message id already used" });
    return existing;
  }
  if (input.text !== undefined) {
    const last = await repository.lastInboundAt(customer.id);
    if (last === null || Date.now() - Date.parse(last) > windowMs) throw new WhatsAppTemplateRequiredError();
  }
  let template: WhatsAppTemplate | undefined;
  if (input.template) {
    if (!config.wabaId) throw new WhatsAppUnavailableError();
    try {
      const wanted = input.template;
      template = (await fetchTemplates(config, { name: wanted.name })).find((item) => item.language === wanted.language);
    } catch (error) {
      throw new WhatsAppSendFailedError(error instanceof WhatsAppSendError ? error.retryable : true);
    }
    if (!template) throw new HTTPException(404, { message: "Template not found" });
    if (!template.sendable || input.template.params.length !== template.variables.length) {
      throw new HTTPException(400, { message: "Template cannot be sent with these values" });
    }
  }
  const to = customer.phone.replace(/\D/g, "");
  const queued = await repository.queueOutbound({
    id, customerId: customer.id, to: customer.phone, from: null, employeeId,
    type: template ? "template" : "text",
    body: template && input.template ? renderTemplate(template, input.template.params) : input.text ?? null,
    templateName: template?.name ?? null,
  });
  if (!queued.created) return queued.message;
  try {
    const externalId = await sendCloudMessage(config, to, template && input.template
      ? { type: "template", name: template.name, language: template.language,
        params: template.variables.map((variable, index) => ({ key: variable.key, named: template.named, value: input.template?.params[index] ?? "" })) }
      : { type: "text", text: input.text ?? "" });
    await repository.markSent(id, externalId);
  } catch (error) {
    await repository.markFailed(id);
    throw new WhatsAppSendFailedError(error instanceof WhatsAppSendError ? error.retryable : true);
  }
  return (await repository.get(id)) ?? queued.message;
}

/**
 * Meta's webhook. Mounted outside Cloudflare Access and the admin guard, because Meta cannot sign in; the
 * HMAC over the raw body is the only credential, and nothing is parsed before it verifies.
 */
export function createWhatsAppWebhookRoutes() {
  const routes = new Hono<AppBindings>();
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
    for (const message of inbound) {
      const stored = await repository.receive({ ...message, to: null });
      // Only a message stored for the first time can trigger a reply; Meta's redeliveries are inserted as no-ops.
      if (stored?.inserted) {
        replies.push(notifyNewMessage(context.env, stored.customerId));
        if (message.media) replies.push(storeInboundMedia(context.env, stored.messageId).then(() => undefined));
        replies.push(runAutoReply(context.env, { customerId: stored.customerId, externalId: message.externalId, body: message.body, sentAt: message.sentAt }));
      }
    }
    for (const status of statuses) await repository.applyStatus(status.externalId, status.status, status.at);
    // Reply after answering Meta, which expects a quick 200; without an execution context (tests) wait for it.
    if (replies.length > 0) await defer(context, Promise.all(replies));
    return context.json({ requestId: context.get("requestId"), received: inbound.length, statuses: statuses.length });
  });
  return routes;
}
