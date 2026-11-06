import { createCustomerRepository, type Customer } from "../../data/customers";
import { createWhatsAppConfigRepository, ruleMatches, type AutoReply } from "../../data/whatsapp-config";
import type { Env } from "../../env";
import { sendToCustomer } from ".";

/** Customer messages older than this are redeliveries of old traffic and never trigger a reply. */
const freshnessMs = 10 * 60_000;

/** Fills {{name}}, {{handler_name}} and {{handler_phone}}; anything else is left as typed. */
export function fillPlaceholders(text: string, values: { name: string; handler_name: string; handler_phone: string }): string {
  return text.replace(/\{\{\s*(name|handler_name|handler_phone)\s*\}\}/g, (_, key: keyof typeof values) => values[key]);
}

async function handlerOf(env: Env, customer: Customer): Promise<{ name: string; phone: string }> {
  const first = customer.employees[0];
  if (!first) return { name: "", phone: "" };
  const row = await env.DB.prepare("SELECT phone_number FROM employees WHERE id = ?").bind(first.id).first<{ phone_number: string | null }>();
  return { name: first.name, phone: row?.phone_number ?? "" };
}

/**
 * Answers a customer's message with the first enabled rule that matches it. Idempotent per (rule, message) and rate-limited per
 * (rule, customer); never throws, because a failed reply must not fail the webhook that delivered the message.
 */
export async function runAutoReply(env: Env, message: { customerId: string; externalId: string; body?: string; sentAt: string }): Promise<void> {
  try {
    if (!message.body || Date.now() - Date.parse(message.sentAt) > freshnessMs) return;
    const repository = createWhatsAppConfigRepository(env.DB);
    const matched: AutoReply | undefined = (await repository.enabledRules()).find((candidate) => ruleMatches(candidate, message.body ?? ""));
    if (!matched) return;
    const logId = await repository.claim(matched.id, message.customerId, message.externalId, matched.cooldownMinutes);
    if (!logId) return;
    try {
      const customer = await createCustomerRepository(env.DB).getCustomer(message.customerId);
      if (!customer) throw new Error("customer missing");
      const handler = await handlerOf(env, customer);
      const values = { name: customer.name, handler_name: handler.name, handler_phone: handler.phone };
      const clientMessageId = crypto.randomUUID();
      if (matched.reply.type === "text") {
        await sendToCustomer(env, customer, { clientMessageId, text: fillPlaceholders(matched.reply.text, values) }, null);
      } else {
        const params = matched.reply.params.map((param) =>
          param.source === "custom" ? param.value ?? "" : param.source === "customer_name" ? values.name
            : param.source === "handler_name" ? values.handler_name : values.handler_phone);
        await sendToCustomer(env, customer, { clientMessageId, template: { name: matched.reply.name, language: matched.reply.language, params } }, null);
      }
    } catch {
      await repository.markLogFailed(logId);
    }
  } catch (error) {
    console.log(JSON.stringify({ job: "whatsapp-auto-reply", status: "error", name: error instanceof Error ? error.name : "unknown" }));
  }
}
