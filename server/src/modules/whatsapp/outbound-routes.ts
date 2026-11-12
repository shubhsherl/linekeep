import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { recordActivity, requestActor } from "../../activity/record";
import type { AppBindings } from "../../app";
import {
  createWhatsAppAttachmentRepository, MAX_TEMPLATE_IMAGE_NAME, mayUseAttachment, type AttachmentOwner,
} from "../../data/whatsapp-attachments";
import type { Env } from "../../env";
import { ApiError } from "../../http/errors";
import {
  attachmentKind, matchesSignature, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_DAY, MAX_IMAGE_BYTES, safeFileName,
  whatsappCanSendAs,
} from "../../whatsapp/attachments";
import { whatsappConfig } from "../../whatsapp/cloud";
import { getTemplates, peekTemplates, TemplateRefreshTooSoonError } from "../../whatsapp/template-cache";
import { deviceAccess, type DeviceBindings, type EmployeeAccess } from "../identity";
import { serveStoredFile } from "./media";
import { listTemplates, WhatsAppSendFailedError, WhatsAppUnavailableError } from "./send";

const attachmentId = z.string().regex(/^wat_[A-Za-z0-9_-]{1,64}$/);
const templateName = z.string().regex(/^[a-z0-9_]{1,512}$/);
const uploadQuery = z.object({ fileName: z.string().max(512).optional() });
const templateImageInput = z.strictObject({ attachmentId });

const errorBody = (requestId: string, code: string, message: string) => ({ requestId, error: { code, message } });

/** Stages one uploaded file in the private bucket for a later WhatsApp send. The raw request body is the file. */
async function uploadAttachment<B extends AppBindings>(context: Context<B>, owner: AttachmentOwner) {
  const type = attachmentKind(context.req.header("Content-Type"));
  if (!type) throw new ApiError(400, "unsupported_media_type", "This file type cannot be sent on WhatsApp");
  const { fileName } = uploadQuery.parse(Object.fromEntries(new URL(context.req.url).searchParams));
  const env = context.env as Env;
  const repository = createWhatsAppAttachmentRepository(env.DB);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  if ((await repository.countSince(owner, since)) >= MAX_ATTACHMENTS_PER_DAY) {
    throw new ApiError(429, "rate_limited", "Too many files uploaded today; try again tomorrow");
  }
  const bytes = new Uint8Array(await context.req.arrayBuffer());
  if (bytes.byteLength === 0) throw new ApiError(400, "empty_file", "The file is empty");
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES || (type.kind === "image" && bytes.byteLength > MAX_IMAGE_BYTES)) {
    throw new ApiError(413, "file_too_large", type.kind === "image" ? "Images can be at most 5 MB" : "Files can be at most 16 MB");
  }
  if (!matchesSignature(type.mimeType, bytes)) {
    throw new ApiError(400, "unsupported_media_type", "The file does not match its declared type");
  }
  const id = `wat_${crypto.randomUUID()}`;
  const objectKey = `whatsapp-outbound/${id}`;
  const name = safeFileName(fileName, type.kind);
  await env.RECORDINGS.put(objectKey, bytes, { httpMetadata: { contentType: type.mimeType } });
  try {
    await repository.create({
      id, ownerType: owner.type, ownerId: owner.id, objectKey, kind: type.kind, mimeType: type.mimeType, fileName: name, size: bytes.byteLength,
    });
  } catch (error) {
    await env.RECORDINGS.delete(objectKey);
    throw error;
  }
  // The kind and size only: neither the file name nor its contents.
  await recordActivity(context, {
    ...requestActor(context), category: "whatsapp", action: "attachment_uploaded", details: { kind: type.kind, bytes: bytes.byteLength },
  });
  return context.json({
    requestId: context.get("requestId"), attachmentId: id, kind: type.kind, mimeType: type.mimeType, fileName: name, size: bytes.byteLength,
  }, 201);
}

const uploadLimit = bodyLimit({
  maxSize: MAX_ATTACHMENT_BYTES,
  onError: () => { throw new ApiError(413, "file_too_large", "Files can be at most 16 MB"); },
});

async function templatesResponse<B extends AppBindings>(context: Context<B>, apiBase: string) {
  const requestId = context.get("requestId");
  try {
    return context.json({ requestId, ...(await listTemplates(context.env as Env, apiBase)) });
  } catch (error) {
    if (error instanceof WhatsAppUnavailableError) {
      return context.json(errorBody(requestId, "WHATSAPP_NOT_CONFIGURED", "WhatsApp templates are not configured"), 503);
    }
    if (error instanceof WhatsAppSendFailedError) {
      return context.json(errorBody(requestId, "WHATSAPP_SEND_FAILED", "WhatsApp templates could not be loaded"), 502);
    }
    throw error;
  }
}

/** The file a template is sent with when the sender does not pick another one. */
async function headerImageResponse<B extends AppBindings>(context: Context<B>) {
  const env = context.env as Env;
  const attachments = createWhatsAppAttachmentRepository(env.DB);
  const configured = (await attachments.templateImages()).get(templateName.parse(context.req.param("templateName") ?? ""));
  const file = configured ? await attachments.get(configured.attachmentId) : null;
  if (!file) throw new HTTPException(404, { message: "Header image not found" });
  return serveStoredFile(env, context.req.raw, { key: file.objectKey, mimeType: file.mimeType, fileName: file.fileName });
}

const noStore: MiddlewareHandler<AppBindings> = async (context, next) => {
  context.header("Cache-Control", "private, no-store");
  await next();
};

/** Mount at /v1/admin: attachments, the template picker's list, and the Config page's default header files. */
export function createAdminWhatsAppOutboundRoutes(authorize: MiddlewareHandler<AppBindings>) {
  const routes = new Hono<AppBindings>();
  for (const path of ["/whatsapp/attachments", "/whatsapp/attachments/*", "/whatsapp/templates", "/whatsapp/templates/*", "/whatsapp/template-images", "/whatsapp/template-images/*"]) {
    routes.use(path, noStore, authorize);
  }
  const adminOwner = (context: Context<AppBindings>): AttachmentOwner => ({ type: "admin", id: context.get("adminId") ?? "local" });

  routes.post("/whatsapp/attachments", uploadLimit, (context) => uploadAttachment(context, adminOwner(context)));
  routes.get("/whatsapp/attachments/:attachmentId", async (context) => {
    const file = await createWhatsAppAttachmentRepository(context.env.DB).get(attachmentId.parse(context.req.param("attachmentId")));
    if (!file || !mayUseAttachment(file, adminOwner(context))) throw new HTTPException(404, { message: "Attachment not found" });
    return serveStoredFile(context.env, context.req.raw, { key: file.objectKey, mimeType: file.mimeType, fileName: file.fileName });
  });
  routes.get("/whatsapp/templates", (context) => templatesResponse(context, "/v1/admin"));
  routes.get("/whatsapp/templates/cache", async (context) => {
    const cached = await peekTemplates(context.env, whatsappConfig(context.env));
    return context.json({
      requestId: context.get("requestId"), count: cached?.templates.length ?? 0,
      fetchedAt: cached?.fetchedAt ?? null, expiresAt: cached?.expiresAt ?? null, stale: cached?.stale ?? false,
    });
  });
  // Forces a fetch from Meta whatever the cache holds; at most one per ten seconds.
  routes.post("/whatsapp/templates/refresh", async (context) => {
    const requestId = context.get("requestId");
    const config = whatsappConfig(context.env);
    if (!config?.wabaId) return context.json(errorBody(requestId, "WHATSAPP_NOT_CONFIGURED", "WhatsApp templates are not configured"), 503);
    try {
      const loaded = await getTemplates(context.env, config, { refresh: true });
      await recordActivity(context, { ...requestActor(context), category: "admin", action: "template_cache_refreshed", details: { count: loaded.templates.length } });
      return context.json({ requestId, count: loaded.templates.length, fetchedAt: loaded.fetchedAt });
    } catch (error) {
      if (error instanceof TemplateRefreshTooSoonError) {
        context.header("Retry-After", String(error.retryAfterSeconds));
        return context.json(errorBody(requestId, "rate_limited", `Templates were just refreshed; try again in ${error.retryAfterSeconds} seconds`), 429);
      }
      return context.json(errorBody(requestId, "WHATSAPP_SEND_FAILED", "WhatsApp templates could not be loaded"), 502);
    }
  });
  routes.get("/whatsapp/templates/:templateName/header-image", (context) => headerImageResponse(context));

  routes.get("/whatsapp/template-images", async (context) => {
    const images = await createWhatsAppAttachmentRepository(context.env.DB).templateImages();
    return context.json({ requestId: context.get("requestId"),
      items: [...images].map(([name, image]) => ({ templateName: name, ...image })) });
  });
  routes.put("/whatsapp/template-images/:templateName", async (context) => {
    const requestId = context.get("requestId");
    const name = templateName.parse(context.req.param("templateName"));
    if (name.length > MAX_TEMPLATE_IMAGE_NAME) throw new HTTPException(400, { message: "Template name is too long" });
    const input = templateImageInput.parse(await context.req.json());
    const repository = createWhatsAppAttachmentRepository(context.env.DB);
    const file = await repository.get(input.attachmentId);
    if (!file || !mayUseAttachment(file, adminOwner(context))) throw new HTTPException(404, { message: "Attachment not found" });
    if (!whatsappCanSendAs(file.mimeType, file.kind)) {
      return context.json(errorBody(requestId, "unsupported_media_type", "WhatsApp cannot send this file as a template header; use JPEG or PNG"), 400);
    }
    const config = whatsappConfig(context.env);
    if (!config?.wabaId) return context.json(errorBody(requestId, "WHATSAPP_NOT_CONFIGURED", "WhatsApp templates are not configured"), 503);
    let formats: string[];
    try {
      formats = (await getTemplates(context.env, config, { name })).templates
        .filter((template) => template.name === name).map((template) => template.headerFormat.toLowerCase());
    } catch {
      return context.json(errorBody(requestId, "WHATSAPP_SEND_FAILED", "WhatsApp templates could not be loaded"), 502);
    }
    if (!formats.includes(file.kind)) {
      return context.json(errorBody(requestId, "header_mismatch",
        formats.length === 0 ? "No approved template has this name" : `This template's header is not an ${file.kind}`), 400);
    }
    await repository.setTemplateImage(name, file.id);
    await recordActivity(context, { ...requestActor(context), category: "admin", action: "template_images_changed", target: { type: "template", id: name, label: name }, details: { change: "set", template: name } });
    return context.json({ requestId, item: { templateName: name, attachmentId: file.id, kind: file.kind, mimeType: file.mimeType, fileName: file.fileName, size: file.size } });
  });
  routes.delete("/whatsapp/template-images/:templateName", async (context) => {
    const name = templateName.parse(context.req.param("templateName"));
    await createWhatsAppAttachmentRepository(context.env.DB).clearTemplateImage(name);
    await recordActivity(context, { ...requestActor(context), category: "admin", action: "template_images_changed", target: { type: "template", id: name, label: name }, details: { change: "removed", template: name } });
    return context.json({ requestId: context.get("requestId"), status: "deleted" });
  });
  return routes;
}

/** Mount at /v1/device (or /v1/web): an employee uploads files for their own sends and reads the same template list. */
export function createDeviceWhatsAppOutboundRoutes(access: EmployeeAccess = deviceAccess) {
  const routes = new Hono<DeviceBindings>();
  routes.post("/whatsapp/attachments", access.authorize, uploadLimit, (context) =>
    uploadAttachment(context, { type: "device", id: context.get("device").id }));
  routes.get("/whatsapp/templates", access.authorize, (context) => templatesResponse(context, access.apiBase));
  routes.get("/whatsapp/templates/:templateName/header-image", access.authorize, (context) => headerImageResponse(context));
  return routes;
}
