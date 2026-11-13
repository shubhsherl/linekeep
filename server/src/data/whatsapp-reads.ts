import { type Clock, timestamp } from "./values";

export type Viewer = { type: "admin" | "employee"; id: string };

/** Chat read markers, kept per viewer. A viewer's unread count is the customer messages newer than their own marker. */
export function createWhatsAppReadRepository(db: D1Database, clock: Clock = () => new Date()) {
  async function baseline(): Promise<string> {
    const row = await db.prepare("SELECT value FROM whatsapp_settings WHERE key = 'unread_since'").first<{ value: string }>();
    return row?.value ?? "9999-12-31T00:00:00.000Z";
  }
  return {
    baseline,

    /** Moves whenever a WhatsApp message is added or changes; clients poll this instead of the lists. */
    async feedVersion(): Promise<number> {
      const row = await db.prepare("SELECT value FROM whatsapp_settings WHERE key = 'feed_version'").first<{ value: string }>();
      return Number(row?.value ?? 0);
    },

    /** Marks the chat read up to its newest customer message as of now. Never moves a marker backwards. */
    async markRead(viewer: Viewer, customerId: string): Promise<void> {
      const now = timestamp(clock);
      await db.prepare(
        `INSERT INTO whatsapp_chat_reads (viewer_type, viewer_id, customer_id, last_read_at, updated_at)
        SELECT ?, ?, ?, MAX(sent_at), ? FROM whatsapp_messages WHERE customer_id = ? AND direction = 'in' HAVING MAX(sent_at) IS NOT NULL
        ON CONFLICT(viewer_type, viewer_id, customer_id) DO UPDATE SET
          last_read_at = MAX(last_read_at, excluded.last_read_at), updated_at = excluded.updated_at`,
      ).bind(viewer.type, viewer.id, customerId, now, customerId).run();
    },

    /** Chats with unread customer messages, and how many messages, among the customers a viewer may see. */
    async totals(viewer: Viewer, employeeScope?: string[]): Promise<{ chats: number; messages: number }> {
      const since = await baseline();
      const row = await db.prepare(
        `SELECT count(DISTINCT m.customer_id) AS chats, count(*) AS messages
        FROM whatsapp_messages m JOIN customers c ON c.id = m.customer_id AND c.archived_at IS NULL
        WHERE m.direction = 'in' AND m.sent_at > ?
          AND m.sent_at > COALESCE((SELECT r.last_read_at FROM whatsapp_chat_reads r
            WHERE r.viewer_type = ? AND r.viewer_id = ? AND r.customer_id = m.customer_id), ?)
          ${employeeScope ? `AND EXISTS (SELECT 1 FROM customer_employees ce WHERE ce.customer_id = c.id
            AND ce.employee_id IN (${employeeScope.length ? employeeScope.map(() => "?").join(", ") : "NULL"}))` : ""}`,
      ).bind(since, viewer.type, viewer.id, since, ...(employeeScope ?? [])).first<{ chats: number; messages: number }>();
      return { chats: row?.chats ?? 0, messages: row?.messages ?? 0 };
    },
  };
}
