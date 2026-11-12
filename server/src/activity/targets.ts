import { callPhoneKey, createCustomerRepository } from "../data/customers";
import type { ActivityTarget } from "./record";

/**
 * What a call event is about: the customer the call was with when the number belongs to one (so the log links to the
 * customer and the customer filter finds it), otherwise the call itself. The number is only used to find the
 * customer; it is never stored.
 */
export async function callTarget(db: D1Database, callId: string, remoteNumber: string | null | undefined): Promise<ActivityTarget> {
  try {
    const key = callPhoneKey(remoteNumber ?? undefined);
    const customer = key ? (await createCustomerRepository(db).matchByPhoneKeys([key])).get(key) : undefined;
    if (customer) return { type: "customer", id: customer.id, label: customer.name };
  } catch {
    // A failed lookup only means the event is about the call.
  }
  return { type: "call", id: callId, label: null };
}
