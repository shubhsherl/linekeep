export type AttachmentKind = "image" | "video" | "document";

/** Largest file accepted for upload. */
export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
/** WhatsApp itself refuses larger images, so a bigger one could never be sent. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Uploads one sender may stage per day; keeps abandoned files from piling up in the bucket. */
export const MAX_ATTACHMENTS_PER_DAY = 200;

const documentTypes = [
  "application/pdf", "application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain", "text/csv",
];
const kinds = new Map<string, AttachmentKind>([
  ["image/jpeg", "image"], ["image/png", "image"], ["image/webp", "image"], ["video/mp4", "video"],
  ...documentTypes.map((type): [string, AttachmentKind] => [type, "document"]),
]);

/** The attachment kind for a Content-Type (parameters ignored), or null when the type may not be uploaded. */
export function attachmentKind(contentType: string | null | undefined): { kind: AttachmentKind; mimeType: string } | null {
  const mimeType = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const kind = kinds.get(mimeType);
  return kind ? { kind, mimeType } : null;
}

const startsWith = (bytes: Uint8Array, offset: number, text: string) =>
  [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));

/** True unless the first bytes contradict the declared type. Office and text files have no reliable signature and pass. */
export function matchesSignature(mimeType: string, bytes: Uint8Array): boolean {
  switch (mimeType) {
    case "image/jpeg": return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png": return bytes[0] === 0x89 && startsWith(bytes, 1, "PNG\r\n");
    case "image/webp": return startsWith(bytes, 0, "RIFF") && startsWith(bytes, 8, "WEBP");
    case "video/mp4": return startsWith(bytes, 4, "ftyp");
    case "application/pdf": return startsWith(bytes, 0, "%PDF");
    default: return true;
  }
}

/** A display name that is safe in headers, bucket metadata and a chat: no paths, control characters or quotes. */
export function safeFileName(raw: string | null | undefined, fallback: string): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>:*?|]/g, "").replace(/\s+/g, " ").trim();
  const trimmed = cleaned.length > 100 ? cleaned.slice(0, 100).trim() : cleaned;
  return trimmed && trimmed !== "." && trimmed !== ".." ? trimmed : fallback;
}

/** WhatsApp cannot send WebP as an image (only as a sticker). */
export function whatsappCanSendAs(mimeType: string, kind: AttachmentKind): boolean {
  return !(kind === "image" && mimeType === "image/webp");
}
