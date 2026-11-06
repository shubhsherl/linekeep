import { createPushRepository } from "../data/push";
import type { Env } from "../env";
import { pushAccount, sendPush, type PushData } from "./fcm";

/** Sends a push to every phone of these employees. Never throws: a failed notification must not fail the action behind it. */
export async function pushToEmployees(env: Env, employeeIds: string[], data: PushData): Promise<void> {
  try {
    const account = pushAccount(env);
    if (!account || employeeIds.length === 0) return;
    const repository = createPushRepository(env.DB);
    const tokens = await repository.tokensFor(employeeIds);
    await Promise.all(tokens.map(async (token) => {
      if ((await sendPush(account, token, data)) === "invalid-token") await repository.deleteToken(token);
    }));
  } catch {
    // Push is best effort.
  }
}

/** Customer messages: the customer's assigned employees. The text is only the customer's name, never the message. */
export async function notifyNewMessage(env: Env, customerId: string): Promise<void> {
  try {
    if (!pushAccount(env)) return;
    const customer = await env.DB.prepare("SELECT name FROM customers WHERE id = ? AND archived_at IS NULL").bind(customerId).first<{ name: string }>();
    if (!customer) return;
    const handlers = await env.DB.prepare("SELECT employee_id FROM customer_employees WHERE customer_id = ?").bind(customerId).all<{ employee_id: string }>();
    await pushToEmployees(env, handlers.results.map((row) => row.employee_id), {
      type: "message", customerId, customerName: customer.name, title: "New WhatsApp message", body: customer.name,
    });
  } catch {
    // best effort
  }
}

/** Newly assigned employees only; removing someone never notifies. */
export async function notifyAssigned(env: Env, customer: { id: string; name: string }, employeeIds: string[]): Promise<void> {
  await pushToEmployees(env, employeeIds, {
    type: "assigned", customerId: customer.id, customerName: customer.name, title: "New customer assigned", body: customer.name,
  });
}
