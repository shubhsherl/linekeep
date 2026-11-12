import { HTTPException } from "hono/http-exception";

import { type Customer, type WhatsAppMessage } from "../../data/customers";
import {
  createWhatsAppAttachmentRepository, mayUseAttachment, type Attachment, type AttachmentOwner,
} from "../../data/whatsapp-attachments";
import { type WhatsAppSendInput } from "../../data/whatsapp-send";
import { createWhatsAppRepository } from "../../data/whatsapp";
import type { Env } from "../../env";
import { whatsappCanSendAs } from "../../whatsapp/attachments";
import {
  REENGAGEMENT_ERROR_CODE, sendCloudMessage, uploadCloudMedia, whatsappConfig, WhatsAppSendError,
  type CloudMedia, type OutboundContent, type WhatsAppConfig,
} from "../../whatsapp/cloud";
import { findTemplate, getTemplates, noteTemplateSendFailure, type TemplateSnapshot } from "../../whatsapp/template-cache";
import { renderTemplate, type WhatsAppTemplate } from "../../whatsapp/templates";
import { whatsappWindow } from "../../whatsapp/window";

/** A template as listed to clients: Meta's definition plus the state of its default header file. */
export interface TemplateListItem extends WhatsAppTemplate {
  /** A media header (image, video or document) has a default file configured in the dashboard. */
  headerImageConfigured: boolean;
  /** Where the default header file can be previewed (API path), only when one is configured. */
  headerImageUrl?: string;
}

/** Approved templates for the picker (from the cache); `apiBase` is `/v1/admin`, `/v1/device` or `/v1/web`. */
export async function listTemplates(env: Env, apiBase: string): Promise<{ items: TemplateListItem[]; cache: { fetchedAt: string; expiresAt: string } }> {
  const config = whatsappConfig(env);
  if (!config?.wabaId) throw new WhatsAppUnavailableError();
  let loaded: TemplateSnapshot;
  try {
    loaded = await getTemplates(env, config);
  } catch (error) {
    throw new WhatsAppSendFailedError(error instanceof WhatsAppSendError ? error.retryable : true);
  }
  const defaults = await createWhatsAppAttachmentRepository(env.DB).templateImages();
  const items = loaded.templates.map((template) => {
    const file = defaults.get(template.name);
    const configured = file !== undefined && file.kind === template.headerFormat.toLowerCase();
    return { ...template, headerImageConfigured: configured,
      ...(configured ? { headerImageUrl: `${apiBase}/whatsapp/templates/${template.name}/header-image` } : {}) };
  });
  return { items, cache: { fetchedAt: loaded.fetchedAt, expiresAt: loaded.expiresAt } };
}

export function whatsappCanSend(env: Env): boolean {
  return whatsappConfig(env) !== null;
}

export class WhatsAppUnavailableError extends Error {}
/** The 24-hour window is closed (or never opened); only an approved template can be sent. */
export class WhatsAppWindowClosedError extends Error {}
/** The template has an image, video or document header and no file was given or configured. */
export class TemplateHeaderRequiredError extends Error {}
/** The attachment does not exist or belongs to someone else (indistinguishable on purpose). */
export class AttachmentNotFoundError extends Error {}
/** The attachment cannot be sent the way it was asked for (wrong kind for the header, or a type WhatsApp refuses). */
export class UnsupportedAttachmentError extends Error {}
export class WhatsAppSendFailedError extends Error {
  constructor(readonly retryable: boolean) { super("WhatsApp message could not be sent"); }
}

/** Meta keeps uploaded media for 30 days; a cached id is reused for 25. */
const metaMediaTtlMs = 25 * 24 * 60 * 60 * 1000;
/** Meta errors that mean the media id itself was not usable, so one fresh upload is worth trying. */
export const staleMediaErrors = new Set([100, 131052, 131053]);

async function ownedAttachment(env: Env, id: string, owner: AttachmentOwner | null): Promise<Attachment> {
  const found = await createWhatsAppAttachmentRepository(env.DB).get(id);
  if (!found || !owner || !mayUseAttachment(found, owner)) throw new AttachmentNotFoundError();
  return found;
}

/** Uploads the staged file to Meta, or reuses the id from an earlier send through the same number. */
export async function metaMedia(env: Env, config: WhatsAppConfig, file: Attachment, fresh: boolean): Promise<{ media: CloudMedia; cached: boolean }> {
  const media = (mediaId: string): CloudMedia => ({ kind: file.kind, mediaId, fileName: file.fileName });
  if (!fresh && file.metaMediaId && file.metaPhoneNumberId === config.phoneNumberId && file.metaUploadedAt
    && Date.now() - Date.parse(file.metaUploadedAt) < metaMediaTtlMs) {
    return { media: media(file.metaMediaId), cached: true };
  }
  const object = await env.RECORDINGS.get(file.objectKey);
  if (!object) throw new WhatsAppSendError(404, null, false);
  const mediaId = await uploadCloudMedia(config, { bytes: await object.arrayBuffer(), mimeType: file.mimeType, fileName: file.fileName });
  await createWhatsAppAttachmentRepository(env.DB).setMetaMedia(file.id, config.phoneNumberId, mediaId);
  return { media: media(mediaId), cached: false };
}

/** Runs `send` with the file's Meta media id; a cached id Meta no longer accepts is replaced once. */
async function sendWithFile(
  env: Env, config: WhatsAppConfig, file: Attachment, send: (media: CloudMedia) => Promise<string>,
): Promise<string> {
  const first = await metaMedia(env, config, file, false);
  try {
    return await send(first.media);
  } catch (error) {
    if (!first.cached || !(error instanceof WhatsAppSendError) || error.code === null || !staleMediaErrors.has(error.code)) throw error;
    await createWhatsAppAttachmentRepository(env.DB).clearMetaMedia(file.id);
    return send((await metaMedia(env, config, file, true)).media);
  }
}

function assertSendable(file: Attachment): void {
  if (!whatsappCanSendAs(file.mimeType, file.kind)) throw new UnsupportedAttachmentError();
}

/** The file for a template's media header: the caller's own choice, else the template's default from Config. */
export async function headerFile(env: Env, template: WhatsAppTemplate, overrideId: string | undefined, owner: AttachmentOwner | null): Promise<Attachment | undefined> {
  const wanted = template.headerFormat.toLowerCase();
  if (!["image", "video", "document"].includes(wanted)) {
    if (overrideId) throw new HTTPException(400, { message: "Template has no media header" });
    return undefined;
  }
  let file: Attachment;
  if (overrideId) {
    file = await ownedAttachment(env, overrideId, owner);
  } else {
    const configured = (await createWhatsAppAttachmentRepository(env.DB).templateImages()).get(template.name);
    const found = configured ? await createWhatsAppAttachmentRepository(env.DB).get(configured.attachmentId) : null;
    if (!found) throw new TemplateHeaderRequiredError();
    file = found;
  }
  if (file.kind !== wanted) {
    if (overrideId) throw new UnsupportedAttachmentError();
    throw new TemplateHeaderRequiredError();
  }
  assertSendable(file);
  return file;
}

/**
 * Sends one message to a customer. The message is stored first, so a failure is visible in the thread and a
 * client retry with the same `clientMessageId` never sends twice. `owner` is who may use staged files: null
 * (automatic replies) can only send templates with their configured default header.
 */
export async function sendToCustomer(
  env: Env, customer: Customer, input: WhatsAppSendInput, employeeId: string | null, owner: AttachmentOwner | null = null,
  apiBase: string = owner?.type === "device" ? "/v1/device" : "/v1/admin",
): Promise<WhatsAppMessage> {
  const config = whatsappConfig(env);
  if (!config) throw new WhatsAppUnavailableError();
  const repository = createWhatsAppRepository(env.DB, undefined, apiBase);
  const id = `wam_${input.clientMessageId}`;
  const existing = await repository.get(id);
  if (existing) {
    if (existing.customerId !== customer.id) throw new HTTPException(409, { message: "Message id already used" });
    return existing;
  }
  if (!("template" in input) && !whatsappWindow(await repository.lastInboundAt(customer.id)).open) {
    throw new WhatsAppWindowClosedError();
  }
  let template: WhatsAppTemplate | undefined;
  let file: Attachment | undefined;
  if ("template" in input) {
    if (!config.wabaId) throw new WhatsAppUnavailableError();
    const wanted = input.template;
    try {
      template = await findTemplate(env, config, wanted.name, wanted.language);
    } catch (error) {
      throw new WhatsAppSendFailedError(error instanceof WhatsAppSendError ? error.retryable : true);
    }
    if (!template) throw new HTTPException(404, { message: "Template not found" });
    if (!template.sendable || wanted.params.length !== template.variables.length) {
      throw new HTTPException(400, { message: "Template cannot be sent with these values" });
    }
    file = await headerFile(env, template, wanted.headerAttachmentId, owner);
  } else if ("attachmentId" in input) {
    file = await ownedAttachment(env, input.attachmentId, owner);
    assertSendable(file);
  }
  const to = customer.phone.replace(/\D/g, "");
  const queued = await repository.queueOutbound({
    id, customerId: customer.id, to: customer.phone, from: null, employeeId,
    type: template ? "template" : "attachmentId" in input && file ? file.kind : "text",
    body: template && "template" in input ? renderTemplate(template, input.template.params)
      : "attachmentId" in input ? input.caption ?? null : "text" in input ? input.text : null,
    templateName: template?.name ?? null,
    ...(file ? { media: { key: file.objectKey, mimeType: file.mimeType, fileName: file.fileName, size: file.size } } : {}),
  });
  if (!queued.created) return queued.message;
  try {
    const content = (media?: CloudMedia): OutboundContent => {
      if (template && "template" in input) {
        return { type: "template", name: template.name, language: template.language, ...(media ? { header: media } : {}),
          params: template.variables.map((variable, index) => ({ key: variable.key, named: template.named, value: input.template.params[index] ?? "" })) };
      }
      if ("attachmentId" in input && media) return { type: "media", media, ...(input.caption ? { caption: input.caption } : {}) };
      return { type: "text", text: "text" in input ? input.text : "" };
    };
    const externalId = file
      ? await sendWithFile(env, config, file, (media) => sendCloudMessage(config, to, content(media)))
      : await sendCloudMessage(config, to, content());
    await repository.markSent(id, externalId);
  } catch (error) {
    await repository.markFailed(id);
    if (template) await noteTemplateSendFailure(env, error);
    // Meta's own 24-hour check disagrees with ours only for free-form content; templates are always allowed.
    if (!template && error instanceof WhatsAppSendError && error.code === REENGAGEMENT_ERROR_CODE) throw new WhatsAppWindowClosedError();
    throw new WhatsAppSendFailedError(error instanceof WhatsAppSendError ? error.retryable : true);
  }
  return (await repository.get(id)) ?? queued.message;
}

/** How the employee web app's sign-in code goes into a template, with every value already resolved. */
export interface OtpTemplateSend {
  name: string; language: string;
  /** 1-based position of the body variable that receives the code. */
  otpParam: number;
  /** Values of the other body variables by 1-based position. */
  otherParams: ReadonlyMap<number, string>;
  /** Authentication templates: send the bare code as the copy-code / URL button parameter too. */
  buttonParam: boolean;
  /** A full sentence for the code's variable; `{{code}}` is replaced by the code. Without it the variable gets the bare code. */
  sentence?: string;
}

/**
 * Sends a one-time sign-in code to an employee's WhatsApp number with an approved template, which Meta allows
 * outside the 24-hour window. Nothing is stored (the recipient is not a customer) and nothing is logged. Failures
 * carry no provider text.
 */
export async function sendOtpTemplate(env: Env, to: string, send: OtpTemplateSend, code: string): Promise<void> {
  const config = whatsappConfig(env);
  if (!config?.wabaId) throw new WhatsAppUnavailableError();
  let template: WhatsAppTemplate | undefined;
  try {
    template = await findTemplate(env, config, send.name, send.language);
  } catch (error) {
    throw new WhatsAppSendFailedError(error instanceof WhatsAppSendError ? error.retryable : true);
  }
  if (!template?.otpCapable || send.otpParam < 1 || send.otpParam > template.variables.length) {
    throw new WhatsAppSendFailedError(false);
  }
  const params = template.variables.map((variable, index) => {
    const value = index + 1 === send.otpParam ? (send.sentence ? send.sentence.replaceAll("{{code}}", code) : code) : send.otherParams.get(index + 1);
    if (value === undefined) throw new WhatsAppSendFailedError(false);
    return { key: variable.key, named: template.named, value };
  });
  try {
    await sendCloudMessage(config, to.replace(/\D/g, ""), {
      type: "template", name: template.name, language: template.language, params,
      ...(send.buttonParam ? { buttonCode: code } : {}),
    });
  } catch (error) {
    await noteTemplateSendFailure(env, error);
    throw new WhatsAppSendFailedError(error instanceof WhatsAppSendError ? error.retryable : true);
  }
}
