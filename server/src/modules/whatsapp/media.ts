import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { AppBindings } from "../../app";
import { createCustomerRepository } from "../../data/customers";
import { createWhatsAppRepository } from "../../data/whatsapp";
import type { Env } from "../../env";
import { downloadMedia, whatsappConfig } from "../../whatsapp/cloud";
import { requireDevice, type DeviceBindings } from "../identity";

const messageId = z.string().regex(/^wam_[0-9a-f-]{36}$/).or(z.string().regex(/^wam_[A-Za-z0-9_-]{1,64}$/));

/** Types a browser may show inline. Anything else is offered as a download only, so a hostile file never runs in our origin. */
const inlineTypes = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr", "audio/opus",
  "video/mp4", "video/3gpp", "application/pdf",
]);

/**
 * Copies a message's media from Meta into the private bucket. Safe to repeat: a stored file is left alone. Returns whether the
 * file is now stored. Never throws, because a failed download must not fail the webhook that announced the message.
 */
export async function storeInboundMedia(env: Env, id: string): Promise<boolean> {
  try {
    const repository = createWhatsAppRepository(env.DB);
    const row = await repository.mediaRow(id);
    if (!row) return false;
    if (row.media_key) return true;
    const config = whatsappConfig(env);
    if (!config || !row.media_id) return false;
    const file = await downloadMedia(config, row.media_id);
    if (!file) return false;
    const key = `whatsapp-media/${id}`;
    // Buffer so R2 gets a known length; the size cap in downloadMedia keeps this bounded.
    const bytes = await new Response(file.body).arrayBuffer();
    if (bytes.byteLength === 0) return false;
    await env.RECORDINGS.put(key, bytes, { httpMetadata: { contentType: row.media_mime ?? file.mimeType } });
    await repository.setMediaStored(id, { key, mimeType: file.mimeType, size: bytes.byteLength });
    return true;
  } catch {
    return false;
  }
}

async function serve(env: Env, request: Request, id: string, allowed: (customerId: string) => Promise<boolean>): Promise<Response> {
  const row = await createWhatsAppRepository(env.DB).mediaRow(id);
  if (!row || !(await allowed(row.customer_id))) throw new HTTPException(404, { message: "Media not found" });
  // A file missing from the bucket is fetched once on demand; Meta keeps ids for about 30 days.
  if (!row.media_key && !(await storeInboundMedia(env, id))) throw new HTTPException(404, { message: "Media not found" });
  const stored = await createWhatsAppRepository(env.DB).mediaRow(id);
  if (!stored?.media_key) throw new HTTPException(404, { message: "Media not found" });
  const range = request.headers.get("Range");
  const object = await env.RECORDINGS.get(stored.media_key, range ? { range: request.headers } : undefined);
  if (!object) throw new HTTPException(404, { message: "Media not found" });
  const declared = (stored.media_mime ?? object.httpMetadata?.contentType ?? "").split(";")[0].trim().toLowerCase();
  const inline = inlineTypes.has(declared);
  const headers = new Headers({
    "Content-Type": inline ? declared : "application/octet-stream",
    "Content-Disposition": inline ? "inline" : `attachment; filename="${(stored.media_name ?? "file").replace(/[^\w.\- ]/g, "_").slice(0, 100)}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
    ETag: object.httpEtag,
  });
  if (range && "range" in object && object.range && "offset" in object.range && object.range.offset !== undefined) {
    const offset = object.range.offset, length = object.range.length ?? object.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

/** Mount at /v1/admin. */
export function createAdminWhatsAppMediaRoutes(authorize: MiddlewareHandler<AppBindings>) {
  const routes = new Hono<AppBindings>();
  routes.use("/whatsapp/messages/*", authorize);
  routes.get("/whatsapp/messages/:messageId/media", (context) =>
    serve(context.env, context.req.raw, messageId.parse(context.req.param("messageId")), async () => true));
  return routes;
}

/** Mount at /v1/device: an employee sees media only from customers assigned to them. */
export function createDeviceWhatsAppMediaRoutes() {
  const routes = new Hono<DeviceBindings>();
  routes.get("/whatsapp/messages/:messageId/media", requireDevice, (context) => {
    const { employeeId } = context.get("device");
    return serve(context.env, context.req.raw, messageId.parse(context.req.param("messageId")),
      async (customerId) => (await createCustomerRepository(context.env.DB).getCustomer(customerId, { employeeId })) !== null);
  });
  return routes;
}
