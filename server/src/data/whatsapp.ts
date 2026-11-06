import { createCustomerRepository, CustomerPhoneExistsError, normalizePhone, message, type MessageRow, type WhatsAppMessage } from "./customers";
import { type Clock, timestamp } from "./values";

/** Order in which a message's delivery state may advance; a late `sent` never undoes `read`. */
const rank = (column: string) =>
  `CASE ${column} WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 1 END`;
const targetRank = { sent: 1, delivered: 2, read: 3, failed: 1.5 } as const;

const selectMessage = `SELECT m.id, m.customer_id, m.direction, m.message_type, m.body, m.media_url, m.media_id, m.media_key,
  m.media_mime, m.media_name, m.media_size,
  m.template_name, m.status, m.from_number, m.to_number, m.sent_at, m.delivered_at, m.read_at,
  m.sent_by_employee_id, e.name AS sent_by_name
  FROM whatsapp_messages m LEFT JOIN employees e ON e.id = m.sent_by_employee_id`;

export interface OutboundDraft {
  id: string; customerId: string; to: string; from: string | null;
  type: "text" | "template"; body: string | null; templateName: string | null; employeeId: string | null;
}

export function createWhatsAppRepository(db: D1Database, clock: Clock = () => new Date()) {
  const customers = createCustomerRepository(db, clock);
  async function get(id: string): Promise<WhatsAppMessage | null> {
    const row = await db.prepare(`${selectMessage} WHERE m.id = ?`).bind(id).first<MessageRow>();
    return row ? message(row) : null;
  }
  return {
    get,

    async mediaRow(messageId: string): Promise<{ id: string; customer_id: string; media_id: string | null; media_key: string | null; media_mime: string | null; media_name: string | null } | null> {
      return db.prepare("SELECT id, customer_id, media_id, media_key, media_mime, media_name FROM whatsapp_messages WHERE id = ?")
        .bind(messageId).first();
    },
    async setMediaStored(messageId: string, media: { key: string; mimeType: string; size: number | null }): Promise<void> {
      await db.prepare(
        "UPDATE whatsapp_messages SET media_key = ?, media_mime = COALESCE(media_mime, ?), media_size = ? WHERE id = ? AND media_key IS NULL",
      ).bind(media.key, media.mimeType, media.size, messageId).run();
    },

    /** When the customer last wrote to us; free text is allowed for 24 hours after this. */
    async lastInboundAt(customerId: string): Promise<string | null> {
      const row = await db.prepare(
        "SELECT max(sent_at) AS at FROM whatsapp_messages WHERE customer_id = ? AND direction = 'in'",
      ).bind(customerId).first<{ at: string | null }>();
      return row?.at ?? null;
    },

    /** Stores the message before calling Meta. A repeated id (client retry) returns the stored one untouched. */
    async queueOutbound(draft: OutboundDraft): Promise<{ message: WhatsAppMessage; created: boolean }> {
      const now = timestamp(clock);
      const result = await db.prepare(
        `INSERT INTO whatsapp_messages (id, customer_id, direction, message_type, body, template_name,
          status, from_number, to_number, sent_at, sent_by_employee_id, source, created_at)
        VALUES (?, ?, 'out', ?, ?, ?, 'queued', ?, ?, ?, ?, 'app', ?)
        ON CONFLICT(id) DO NOTHING`,
      ).bind(draft.id, draft.customerId, draft.type, draft.body, draft.templateName, draft.from, draft.to, now,
        draft.employeeId, now).run();
      const stored = await get(draft.id);
      if (!stored) throw new Error("Message write returned no row");
      return { message: stored, created: result.meta.changes > 0 };
    },

    async markSent(id: string, externalId: string): Promise<void> {
      await db.prepare(
        `UPDATE whatsapp_messages SET external_id = ?, status = CASE WHEN status = 'queued' THEN 'sent' ELSE status END
        WHERE id = ? AND direction = 'out'`,
      ).bind(externalId, id).run();
    },

    async markFailed(id: string): Promise<void> {
      await db.prepare("UPDATE whatsapp_messages SET status = 'failed' WHERE id = ? AND status = 'queued'").bind(id).run();
    },

    /** Applies a delivery receipt; unknown ids and out-of-order receipts change nothing. */
    async applyStatus(externalId: string, status: keyof typeof targetRank, at: string): Promise<void> {
      await db.prepare(
        `UPDATE whatsapp_messages SET status = ?1,
          delivered_at = CASE WHEN ?1 IN ('delivered', 'read') THEN COALESCE(delivered_at, ?2) ELSE delivered_at END,
          read_at = CASE WHEN ?1 = 'read' THEN COALESCE(read_at, ?2) ELSE read_at END
        WHERE external_id = ?3 AND direction = 'out' AND ${rank("status")} < ?4`,
      ).bind(status, at, externalId, targetRank[status]).run();
    },

    /**
     * Stores a customer's message, creating an unassigned customer for an unknown number.
     * Meta redelivers webhooks, so the provider id makes this idempotent.
     */
    async receive(input: { externalId: string; from: string; name?: string; type: string; body?: string; sentAt: string; to: string | null; media?: { id: string; mimeType?: string; fileName?: string } }): Promise<{ customerId: string; messageId: string; inserted: boolean } | null> {
      const normalized = normalizePhone(input.from);
      if (!normalized) return null;
      const find = () => db.prepare("SELECT id FROM customers WHERE phone_key = ? AND archived_at IS NULL")
        .bind(normalized.phoneKey).first<{ id: string }>();
      let customerId = (await find())?.id;
      if (!customerId) {
        try {
          customerId = (await customers.createCustomer({
            name: input.name ?? normalized.phone, phone: normalized.phone, source: "whatsapp",
          })).id;
        } catch (error) {
          if (!(error instanceof CustomerPhoneExistsError)) throw error;
          customerId = (await find())?.id;
        }
      }
      if (!customerId) return null;
      const messageId = `wam_${crypto.randomUUID()}`;
      const result = await db.prepare(
        `INSERT INTO whatsapp_messages (id, customer_id, external_id, direction, message_type, body, status,
          from_number, to_number, sent_at, source, created_at, media_id, media_mime, media_name)
        VALUES (?, ?, ?, 'in', ?, ?, 'delivered', ?, ?, ?, 'provider', ?, ?, ?, ?)
        ON CONFLICT(external_id) DO NOTHING`,
      ).bind(messageId, customerId, input.externalId, input.type, input.body ?? null,
        normalized.phone, input.to, input.sentAt, timestamp(clock),
        input.media?.id ?? null, input.media?.mimeType ?? null, input.media?.fileName ?? null).run();
      return { customerId, messageId, inserted: result.meta.changes > 0 };
    },
  };
}
