import type { Env } from "../env";

export interface WhatsAppConfig { token: string; phoneNumberId: string; version: string; wabaId: string | null }

/** Sending needs the access token and the sending number; null leaves the feature off. */
export function whatsappConfig(env: Pick<Env, "WHATSAPP_TOKEN" | "WHATSAPP_PHONE_NUMBER_ID" | "WHATSAPP_GRAPH_VERSION" | "WHATSAPP_WABA_ID">): WhatsAppConfig | null {
  const token = env.WHATSAPP_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneNumberId || !/^\d{5,32}$/.test(phoneNumberId)) return null;
  const version = env.WHATSAPP_GRAPH_VERSION?.trim() || "v23.0";
  const wabaId = env.WHATSAPP_WABA_ID?.trim();
  return /^v\d+\.\d+$/.test(version)
    ? { token, phoneNumberId, version, wabaId: wabaId && /^\d{5,32}$/.test(wabaId) ? wabaId : null }
    : null;
}

/** Meta rejected or could not process the request. `retryable` is true for transport and 5xx failures. */
export class WhatsAppSendError extends Error {
  constructor(readonly status: number, readonly code: number | null, readonly retryable: boolean) {
    super(`WhatsApp API error ${status}${code === null ? "" : ` (${code})`}`);
  }
}

/** Meta's "more than 24 hours have passed since the customer last replied" error. */
export const REENGAGEMENT_ERROR_CODE = 131047;

export type MediaKind = "image" | "video" | "document";
/** A file already uploaded to Meta; `fileName` is only used for documents. */
export interface CloudMedia { kind: MediaKind; mediaId: string; fileName?: string }

export type OutboundContent =
  | { type: "text"; text: string }
  | { type: "media"; media: CloudMedia; caption?: string }
  | {
    type: "template"; name: string; language: string; params: { key: string; named: boolean; value: string }[];
    /** Image, video or document shown above the body of a template that has a media header. */
    header?: CloudMedia;
  };

const mediaObject = (media: CloudMedia, caption?: string) => ({
  id: media.mediaId,
  ...(caption ? { caption } : {}),
  ...(media.kind === "document" && media.fileName ? { filename: media.fileName } : {}),
});

function messageBody(content: OutboundContent) {
  switch (content.type) {
    case "text": return { type: "text", text: { body: content.text, preview_url: false } };
    case "media": return { type: content.media.kind, [content.media.kind]: mediaObject(content.media, content.caption) };
    case "template": {
      const components: object[] = [];
      if (content.header) {
        components.push({ type: "header", parameters: [{ type: content.header.kind, [content.header.kind]: mediaObject(content.header) }] });
      }
      if (content.params.length > 0) {
        components.push({ type: "body", parameters: content.params.map((param) => ({
          type: "text", text: param.value, ...(param.named ? { parameter_name: param.key } : {}),
        })) });
      }
      return { type: "template", template: {
        name: content.name, language: { code: content.language }, ...(components.length > 0 ? { components } : {}),
      } };
    }
  }
}

/** Sends one message and returns Meta's message id. `to` is digits only, with country code. */
export async function sendCloudMessage(config: WhatsAppConfig, to: string, content: OutboundContent): Promise<string> {
  const body = { messaging_product: "whatsapp", recipient_type: "individual", to, ...messageBody(content) };
  let response: Response;
  try {
    response = await fetch(`https://graph.facebook.com/${config.version}/${config.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new WhatsAppSendError(0, null, true);
  }
  const parsed = await response.json().catch(() => null) as
    { messages?: { id?: unknown }[]; error?: { code?: unknown } } | null;
  const id = parsed?.messages?.[0]?.id;
  if (response.ok && typeof id === "string" && id.length > 0 && id.length <= 256) return id;
  const code = typeof parsed?.error?.code === "number" ? parsed.error.code : null;
  throw new WhatsAppSendError(response.status, code, response.status >= 500 || response.status === 429);
}

/** Uploads a file to Meta (`POST /{phone-number-id}/media`) and returns its media id, valid for about 30 days. */
export async function uploadCloudMedia(config: WhatsAppConfig, file: { bytes: ArrayBuffer; mimeType: string; fileName: string }): Promise<string> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", file.mimeType);
  form.append("file", new Blob([file.bytes], { type: file.mimeType }), file.fileName);
  let response: Response;
  try {
    response = await fetch(`https://graph.facebook.com/${config.version}/${config.phoneNumberId}/media`, {
      method: "POST", headers: { Authorization: `Bearer ${config.token}` }, body: form, signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new WhatsAppSendError(0, null, true);
  }
  const parsed = await response.json().catch(() => null) as { id?: unknown; error?: { code?: unknown } } | null;
  if (response.ok && typeof parsed?.id === "string" && /^\d{5,40}$/.test(parsed.id)) return parsed.id;
  const code = typeof parsed?.error?.code === "number" ? parsed.error.code : null;
  throw new WhatsAppSendError(response.status, code, response.status >= 500 || response.status === 429);
}

function hexBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

/** Checks Meta's `X-Hub-Signature-256` over the exact raw body, in constant time. */
export async function verifyWebhookSignature(secret: string, rawBody: string, header: string | undefined): Promise<boolean> {
  const match = header?.match(/^sha256=([0-9a-f]{64})$/i);
  const signature = match ? hexBytes(match[1]) : null;
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(rawBody));
}

export const MEDIA_TYPES = ["image", "video", "audio", "document", "sticker"] as const;
export interface InboundMedia { id: string; mimeType?: string; fileName?: string }
export interface InboundMessage {
  externalId: string; from: string; name?: string; type: string; body?: string; sentAt: string; media?: InboundMedia;
}
export interface StatusUpdate {
  externalId: string; status: "sent" | "delivered" | "read" | "failed"; at: string;
}

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
const seconds = (value: unknown): string =>
  (typeof value === "string" && /^\d{1,12}$/.test(value) ? new Date(Number(value) * 1000) : new Date()).toISOString();

/** The words a customer sees for each inbound message type; null for types with nothing to show (stickers, audio). */
function inboundText(item: Record<string, any>, type: string): string | undefined {
  const part = item[type];
  switch (type) {
    case "text": return part?.body;
    case "button": return part?.text ?? part?.payload;
    case "interactive": {
      const reply = part?.button_reply ?? part?.list_reply ?? part?.nfm_reply;
      return reply?.title ?? reply?.body ?? reply?.id;
    }
    case "reaction": return part?.emoji;
    case "location": return [part?.name, part?.address].filter(Boolean).join(", ") || undefined;
    default: return part?.caption ?? part?.body;
  }
}

/** Pulls inbound messages and delivery statuses for our number out of a webhook payload, ignoring anything else. */
export function parseWebhook(payload: unknown, phoneNumberId: string) {
  const inbound: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  const entries = (payload as { entry?: unknown })?.entry;
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value;
      if (change?.field !== "messages" || value?.metadata?.phone_number_id !== phoneNumberId) continue;
      const names = new Map<string, string>();
      for (const contact of Array.isArray(value.contacts) ? value.contacts : []) {
        const waId = text(contact?.wa_id, 32), name = text(contact?.profile?.name, 200);
        if (waId && name) names.set(waId, name);
      }
      for (const item of Array.isArray(value.messages) ? value.messages : []) {
        const externalId = text(item?.id, 256), from = text(item?.from, 32), type = text(item?.type, 40);
        if (!externalId || !from || !type || !/^\d{5,20}$/.test(from)) continue;
        const part = (MEDIA_TYPES as readonly string[]).includes(type) ? item[type] : undefined;
        const mediaId = text(part?.id, 256);
        inbound.push({
          externalId, from, type, name: names.get(from), body: text(inboundText(item, type), 4096), sentAt: seconds(item.timestamp),
          ...(mediaId ? { media: { id: mediaId, mimeType: text(part?.mime_type, 127), fileName: text(part?.filename, 255) } } : {}),
        });
      }
      for (const item of Array.isArray(value.statuses) ? value.statuses : []) {
        const externalId = text(item?.id, 256);
        if (!externalId || !["sent", "delivered", "read", "failed"].includes(item?.status)) continue;
        statuses.push({ externalId, status: item.status, at: seconds(item.timestamp) });
      }
    }
  }
  return { inbound, statuses };
}

/** Largest media file we keep; WhatsApp itself allows up to 100 MB for documents. */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export interface DownloadedMedia { body: ReadableStream<Uint8Array>; mimeType: string; size: number | null }

/** Fetches a media file by Meta's id: one call for its temporary URL, one for the bytes. Null when Meta no longer has it. */
export async function downloadMedia(config: WhatsAppConfig, mediaId: string): Promise<DownloadedMedia | null> {
  if (!/^\d{5,40}$/.test(mediaId)) return null;
  const headers = { Authorization: `Bearer ${config.token}` };
  const meta = await fetch(`https://graph.facebook.com/${config.version}/${mediaId}`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!meta.ok) return null;
  const info = await meta.json().catch(() => null) as { url?: unknown; mime_type?: unknown; file_size?: unknown } | null;
  if (typeof info?.url !== "string" || !/^https:\/\/[a-z0-9.-]+\.(?:fbcdn\.net|facebook\.com|fbsbx\.com|whatsapp\.net|whatsapp\.com)\//i.test(info.url)) return null;
  const declared = typeof info.file_size === "number" ? info.file_size : null;
  if (declared !== null && declared > MAX_MEDIA_BYTES) return null;
  const file = await fetch(info.url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!file.ok || !file.body) return null;
  const length = Number(file.headers.get("Content-Length") ?? declared ?? 0);
  if (length > MAX_MEDIA_BYTES) return null;
  const mimeType = typeof info.mime_type === "string" ? info.mime_type : file.headers.get("Content-Type") ?? "application/octet-stream";
  return { body: file.body, mimeType: mimeType.slice(0, 127), size: length > 0 ? length : declared };
}

export interface PhoneNumberCheck { ok: boolean; displayPhoneNumber?: string; verifiedName?: string; error?: string }

/**
 * Asks Graph for the sending number with the configured token. The message is chosen here from Meta's status and
 * error code, never copied from the response, so it cannot echo the token or anything else private.
 */
export async function checkPhoneNumber(config: Pick<WhatsAppConfig, "token" | "phoneNumberId" | "version">): Promise<PhoneNumberCheck> {
  let response: Response;
  try {
    response = await fetch(
      `https://graph.facebook.com/${config.version}/${config.phoneNumberId}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${config.token}` }, redirect: "manual", signal: AbortSignal.timeout(10_000) },
    );
  } catch {
    return { ok: false, error: "Could not reach Meta's Graph API. Try again in a moment." };
  }
  const parsed = await response.json().catch(() => null) as
    { display_phone_number?: unknown; verified_name?: unknown; error?: { code?: unknown } } | null;
  if (response.ok) {
    const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;
    return { ok: true, displayPhoneNumber: text(parsed?.display_phone_number), verifiedName: text(parsed?.verified_name) };
  }
  const code = typeof parsed?.error?.code === "number" ? parsed.error.code : null;
  if (code === 190 || response.status === 401) return { ok: false, error: "Meta rejected the access token: it is invalid or has expired." };
  if (code === 100 || response.status === 404) return { ok: false, error: "Meta could not find this phone number id, or the token cannot access it." };
  if (code === 10 || code === 200 || response.status === 403) return { ok: false, error: "The token does not have permission for this phone number (needs whatsapp_business_management)." };
  return { ok: false, error: `Meta's Graph API returned an error (HTTP ${response.status}${code === null ? "" : `, code ${code}`}).` };
}
