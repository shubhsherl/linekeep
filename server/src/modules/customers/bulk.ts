import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { z } from "zod";

import type { AppBindings } from "../../app";
import { BULK_MAX_ROWS, importCustomers } from "../../data/customers-bulk";
import type { Env } from "../../env";
import { defer } from "../../http/defer";
import { ApiError } from "../../http/errors";
import { notifyBulkAssigned } from "../../push/notify";
import { whatsappConfig } from "../../whatsapp/cloud";
import { introInput, prepareIntro, sendIntros, type IntroResult, type PreparedIntro } from "../whatsapp/bulk-intro";
import {
  AttachmentNotFoundError, UnsupportedAttachmentError, WhatsAppSendFailedError, WhatsAppUnavailableError,
} from "../whatsapp/send";

/** Largest accepted body: 25 rows of the longest allowed name, phone, notes and employee id fit with room to spare. */
export const BULK_BODY_LIMIT = 256 * 1024;

/**
 * Workers Free allows 50 subrequests (fetch calls) per invocation, and the intro messages and the push run inside it. A full
 * request makes at most 1 template lookup + 1 header upload (or, for a stale cached id, 1 re-upload and up to 3 re-sends) +
 * one send per row (25) + the push calls. Pushes get what is left of this budget, which keeps the total under 50.
 */
const EXTERNAL_FETCH_BUDGET = 45;

const bulkRow = z.strictObject({
  name: z.string(),
  phone: z.string(),
  notes: z.string().optional(),
  employeeId: z.string().max(256).optional(),
});
const bulkInput = z.strictObject({ rows: z.array(bulkRow).min(1), intro: introInput.optional() });

/** POST /customers/bulk: see server/README.md. Rows are judged one by one; only a malformed request fails as a whole. */
export async function bulkCreateCustomers(context: Context<AppBindings>) {
  const requestId = context.get("requestId");
  const env = context.env as Env;
  const raw: unknown = await context.req.json().catch(() => {
    throw new HTTPException(400, { message: "Invalid JSON" });
  });
  const given = (raw as { rows?: unknown } | null)?.rows;
  if (Array.isArray(given) && given.length > BULK_MAX_ROWS) {
    throw new ApiError(400, "too_many_rows", `At most ${BULK_MAX_ROWS} customers can be added per request; send the rest in further requests`);
  }
  const input = bulkInput.parse(raw);

  let prepared: PreparedIntro | undefined;
  const owner = { type: "admin" as const, id: context.get("adminId") ?? "local" };
  if (input.intro) {
    if (!context.get("features")?.whatsapp) {
      throw new ApiError(404, "feature_disabled", "This feature is turned off. An administrator can turn it on in Config.");
    }
    const config = whatsappConfig(env);
    if (!config) throw new ApiError(503, "WHATSAPP_NOT_CONFIGURED", "WhatsApp sending is not configured");
    try {
      // Everything about the template is checked before a customer is created.
      prepared = await prepareIntro(env, config, input.intro, owner);
    } catch (error) {
      if (error instanceof WhatsAppUnavailableError) throw new ApiError(503, "WHATSAPP_NOT_CONFIGURED", "WhatsApp templates are not configured");
      if (error instanceof WhatsAppSendFailedError) throw new ApiError(502, "WHATSAPP_SEND_FAILED", "WhatsApp templates could not be loaded");
      if (error instanceof AttachmentNotFoundError) throw new ApiError(404, "attachment_not_found", "The attachment was not found; upload it again");
      if (error instanceof UnsupportedAttachmentError) {
        throw new ApiError(400, "unsupported_media_type", "WhatsApp cannot send this file in this place; images must be JPEG or PNG");
      }
      throw error;
    }
  }

  const { results, created, employees } = await importCustomers(env.DB, input.rows);

  let fetches = 0;
  const intros = new Map<number, IntroResult>();
  if (prepared && created.length > 0) {
    const sent = await sendIntros(env, prepared, created.map((row) => {
      const handler = row.assigned && row.employeeId ? employees.get(row.employeeId) : undefined;
      return { customerId: row.id, name: row.name, phone: row.phone, handler: handler ? { name: handler.name, phone: handler.phone } : null };
    }));
    fetches = sent.fetches;
    created.forEach((row, position) => intros.set(row.index, sent.results[position] ?? { status: "failed", reason: "send_failed" }));
  }

  const groups = new Map<string, { employeeId: string; customers: { id: string; name: string }[] }>();
  for (const row of created) {
    if (!row.assigned || !row.employeeId) continue;
    const group = groups.get(row.employeeId) ?? { employeeId: row.employeeId, customers: [] };
    group.customers.push({ id: row.id, name: row.name });
    groups.set(row.employeeId, group);
  }
  if (groups.size > 0) await defer(context, notifyBulkAssigned(env, [...groups.values()], EXTERNAL_FETCH_BUDGET - fetches));

  return context.json({
    requestId,
    results: results.map((result) => (intros.has(result.index) ? { ...result, intro: intros.get(result.index) } : result)),
  });
}
