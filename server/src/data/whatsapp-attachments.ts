import type { AttachmentKind } from "../whatsapp/attachments";
import { type Clock, timestamp } from "./values";

/** Who staged a file: any administrator, or one enrolled device. */
export type AttachmentOwner = { type: "admin" | "device"; id: string };

export interface Attachment {
  id: string; ownerType: AttachmentOwner["type"]; ownerId: string; objectKey: string;
  kind: AttachmentKind; mimeType: string; fileName: string; size: number;
  metaMediaId: string | null; metaPhoneNumberId: string | null; metaUploadedAt: string | null; createdAt: string;
}

type Row = {
  id: string; owner_type: Attachment["ownerType"]; owner_id: string; object_key: string; kind: AttachmentKind;
  mime_type: string; file_name: string; size: number; meta_media_id: string | null; meta_phone_number_id: string | null;
  meta_uploaded_at: string | null; created_at: string;
};

const columns = `id, owner_type, owner_id, object_key, kind, mime_type, file_name, size, meta_media_id,
  meta_phone_number_id, meta_uploaded_at, created_at`;

function attachment(row: Row): Attachment {
  return {
    id: row.id, ownerType: row.owner_type, ownerId: row.owner_id, objectKey: row.object_key, kind: row.kind,
    mimeType: row.mime_type, fileName: row.file_name, size: row.size, metaMediaId: row.meta_media_id,
    metaPhoneNumberId: row.meta_phone_number_id, metaUploadedAt: row.meta_uploaded_at, createdAt: row.created_at,
  };
}

/** Administrators share their files; a device can only use what it uploaded itself. */
export function mayUseAttachment(found: Attachment, owner: AttachmentOwner): boolean {
  return owner.type === "admin" ? found.ownerType === "admin" : found.ownerType === "device" && found.ownerId === owner.id;
}

export interface TemplateImage { attachmentId: string; kind: AttachmentKind; mimeType: string; fileName: string; size: number }

const templateImagePrefix = "whatsapp.templateImage.";
/** `app_settings` keys are at most 100 characters. */
export const MAX_TEMPLATE_IMAGE_NAME = 100 - templateImagePrefix.length;

export function createWhatsAppAttachmentRepository(db: D1Database, clock: Clock = () => new Date()) {
  return {
    async create(input: Omit<Attachment, "metaMediaId" | "metaPhoneNumberId" | "metaUploadedAt" | "createdAt">): Promise<Attachment> {
      const now = timestamp(clock);
      await db.prepare(
        `INSERT INTO whatsapp_attachments (id, owner_type, owner_id, object_key, kind, mime_type, file_name, size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(input.id, input.ownerType, input.ownerId, input.objectKey, input.kind, input.mimeType, input.fileName, input.size, now).run();
      return { ...input, metaMediaId: null, metaPhoneNumberId: null, metaUploadedAt: null, createdAt: now };
    },

    async get(id: string): Promise<Attachment | null> {
      const row = await db.prepare(`SELECT ${columns} FROM whatsapp_attachments WHERE id = ?`).bind(id).first<Row>();
      return row ? attachment(row) : null;
    },

    async countSince(owner: AttachmentOwner, since: string): Promise<number> {
      const row = await db.prepare(
        "SELECT count(*) AS n FROM whatsapp_attachments WHERE owner_type = ? AND owner_id = ? AND created_at >= ?",
      ).bind(owner.type, owner.id, since).first<{ n: number }>();
      return row?.n ?? 0;
    },

    /** Remembers the id Meta gave the file, so later sends of the same file skip the upload. */
    async setMetaMedia(id: string, phoneNumberId: string, mediaId: string): Promise<void> {
      await db.prepare(
        "UPDATE whatsapp_attachments SET meta_media_id = ?, meta_phone_number_id = ?, meta_uploaded_at = ? WHERE id = ?",
      ).bind(mediaId, phoneNumberId, timestamp(clock), id).run();
    },

    async clearMetaMedia(id: string): Promise<void> {
      await db.prepare(
        "UPDATE whatsapp_attachments SET meta_media_id = NULL, meta_phone_number_id = NULL, meta_uploaded_at = NULL WHERE id = ?",
      ).bind(id).run();
    },

    /** The default header file of each template (by name), kept as a setting that points at a staged attachment. */
    async templateImages(): Promise<Map<string, TemplateImage>> {
      const rows = await db.prepare(
        `SELECT s.key, a.id, a.kind, a.mime_type, a.file_name, a.size FROM app_settings s
        JOIN whatsapp_attachments a ON a.id = s.value WHERE s.key LIKE ?`,
      ).bind(`${templateImagePrefix}%`).all<{ key: string; id: string; kind: AttachmentKind; mime_type: string; file_name: string; size: number }>();
      return new Map(rows.results.map((row) => [row.key.slice(templateImagePrefix.length), {
        attachmentId: row.id, kind: row.kind, mimeType: row.mime_type, fileName: row.file_name, size: row.size,
      }]));
    },

    async setTemplateImage(templateName: string, attachmentId: string): Promise<void> {
      await db.prepare(
        `INSERT INTO app_settings (key, value, encrypted, updated_at) VALUES (?, ?, 0, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).bind(templateImagePrefix + templateName, attachmentId, timestamp(clock)).run();
    },

    async clearTemplateImage(templateName: string): Promise<void> {
      await db.prepare("DELETE FROM app_settings WHERE key = ?").bind(templateImagePrefix + templateName).run();
    },

    /** Files older than `before` that no message and no template default refers to. */
    async unreferenced(before: string, limit: number): Promise<{ id: string; objectKey: string }[]> {
      const rows = await db.prepare(
        `SELECT a.id, a.object_key FROM whatsapp_attachments a
        WHERE a.created_at < ?
          AND NOT EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.media_key = a.object_key)
          AND NOT EXISTS (SELECT 1 FROM app_settings s WHERE s.key LIKE 'whatsapp.templateImage.%' AND s.value = a.id)
        ORDER BY a.created_at LIMIT ?`,
      ).bind(before, limit).all<{ id: string; object_key: string }>();
      return rows.results.map((row) => ({ id: row.id, objectKey: row.object_key }));
    },

    async deleteRows(ids: string[]): Promise<void> {
      if (ids.length === 0) return;
      await db.prepare(`DELETE FROM whatsapp_attachments WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).run();
    },
  };
}
