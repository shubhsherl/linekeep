import { z } from "zod";

import { type Clock, timestamp } from "./values";

export const MAX_RULES = 50;
export const MAX_QUICK_MESSAGES = 100;

/** Lower-case, single-spaced, trimmed: how both keywords and customer messages are compared. */
export function normalizeMatchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const matchType = z.enum(["contains", "exact", "starts_with"]);
const keyword = z.string().max(100).transform(normalizeMatchText).pipe(z.string().min(1));
const keywords = z.preprocess(
  (value) => (Array.isArray(value) ? [...new Set(value.map((item) => (typeof item === "string" ? normalizeMatchText(item) : item)))] : value),
  z.array(keyword).min(1).max(20),
);
const param = z.strictObject({
  source: z.enum(["customer_name", "handler_name", "handler_phone", "custom"]),
  value: z.string().trim().min(1).max(1024).regex(/^[^\n\r\t]*$/).optional(),
}).refine((value) => (value.source === "custom") === (value.value !== undefined), {
  message: "Only custom parameters carry a value",
});
const reply = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string().trim().min(1).max(4096) }),
  z.strictObject({
    type: z.literal("template"),
    name: z.string().regex(/^[a-z0-9_]{1,512}$/),
    language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/),
    params: z.array(param).max(20).default([]),
  }),
]);
const name = z.string().trim().min(1).max(120);
const cooldown = z.number().int().min(1).max(10080);

export const autoReplyCreate = z.strictObject({
  name, enabled: z.boolean().default(true), matchType, keywords, reply, cooldownMinutes: cooldown.default(1440),
});
export const autoReplyUpdate = z.strictObject({
  name: name.optional(), enabled: z.boolean().optional(), matchType: matchType.optional(),
  keywords: keywords.optional(), reply: reply.optional(), cooldownMinutes: cooldown.optional(),
}).refine((value) => Object.values(value).some((field) => field !== undefined), { message: "Nothing to update" });
export const quickMessageCreate = z.strictObject({
  title: z.string().trim().min(1).max(80), text: z.string().trim().min(1).max(4096),
});
export const quickMessageUpdate = z.strictObject({
  title: z.string().trim().min(1).max(80).optional(), text: z.string().trim().min(1).max(4096).optional(),
}).refine((value) => value.title !== undefined || value.text !== undefined, { message: "Nothing to update" });

export type AutoReplyReply = z.infer<typeof reply>;
export interface AutoReply {
  id: string; name: string; enabled: boolean; matchType: z.infer<typeof matchType>; keywords: string[];
  reply: AutoReplyReply; cooldownMinutes: number; triggerCount: number; lastTriggeredAt?: string;
  createdAt: string; updatedAt: string;
}
export interface QuickMessage { id: string; title: string; text: string; createdAt: string; updatedAt: string }
export interface AutoReplyActivity {
  id: string; ruleName: string; customerId: string; customerName: string; status: "sent" | "failed"; at: string;
}

type RuleRow = {
  id: string; name: string; enabled: number; match_type: AutoReply["matchType"]; keywords: string;
  reply_type: "text" | "template"; reply_text: string | null; template_name: string | null;
  template_language: string | null; template_params: string | null; cooldown_minutes: number;
  created_at: string; updated_at: string; trigger_count: number; last_triggered_at: string | null;
};

function rule(row: RuleRow): AutoReply {
  return {
    id: row.id, name: row.name, enabled: row.enabled === 1, matchType: row.match_type,
    keywords: JSON.parse(row.keywords) as string[],
    reply: row.reply_type === "text"
      ? { type: "text", text: row.reply_text ?? "" }
      : { type: "template", name: row.template_name ?? "", language: row.template_language ?? "",
        params: row.template_params ? JSON.parse(row.template_params) : [] },
    cooldownMinutes: row.cooldown_minutes, triggerCount: row.trigger_count,
    lastTriggeredAt: row.last_triggered_at ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** Does a customer's message trigger this rule? */
export function ruleMatches(candidate: Pick<AutoReply, "matchType" | "keywords">, message: string): boolean {
  const text = normalizeMatchText(message);
  if (!text) return false;
  return candidate.keywords.some((word) =>
    candidate.matchType === "exact" ? text === word
      : candidate.matchType === "starts_with" ? text.startsWith(word) : text.includes(word));
}

const ruleSelect = `SELECT r.*,
  (SELECT count(*) FROM whatsapp_auto_reply_log l WHERE l.rule_id = r.id AND l.status = 'sent') AS trigger_count,
  (SELECT max(l.created_at) FROM whatsapp_auto_reply_log l WHERE l.rule_id = r.id AND l.status = 'sent') AS last_triggered_at
  FROM whatsapp_auto_replies r`;

export class ConfigLimitError extends Error {}
export class ConfigOrderError extends Error {}

export function createWhatsAppConfigRepository(db: D1Database, clock: Clock = () => new Date()) {
  async function getRule(id: string): Promise<AutoReply | null> {
    const row = await db.prepare(`${ruleSelect} WHERE r.id = ?`).bind(id).first<RuleRow>();
    return row ? rule(row) : null;
  }
  const columns = (value: z.infer<typeof autoReplyCreate>) => [
    value.name, value.enabled ? 1 : 0, value.matchType, JSON.stringify(value.keywords), value.reply.type,
    value.reply.type === "text" ? value.reply.text : null,
    value.reply.type === "template" ? value.reply.name : null,
    value.reply.type === "template" ? value.reply.language : null,
    value.reply.type === "template" ? JSON.stringify(value.reply.params) : null, value.cooldownMinutes,
  ];
  return {
    getRule,
    async listRules(): Promise<AutoReply[]> {
      const rows = await db.prepare(`${ruleSelect} ORDER BY r.position, r.created_at, r.id`).all<RuleRow>();
      return rows.results.map(rule);
    },
    async createRule(input: z.input<typeof autoReplyCreate>): Promise<AutoReply> {
      const value = autoReplyCreate.parse(input);
      const id = `war_${crypto.randomUUID()}`, now = timestamp(clock);
      const result = await db.prepare(
        `INSERT INTO whatsapp_auto_replies (id, name, enabled, match_type, keywords, reply_type, reply_text, template_name,
          template_language, template_params, cooldown_minutes, position, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(MAX(position), 0) + 1, ?, ? FROM whatsapp_auto_replies
        HAVING count(*) < ?`,
      ).bind(id, ...columns(value), now, now, MAX_RULES).run();
      if (result.meta.changes === 0) throw new ConfigLimitError();
      return (await getRule(id)) as AutoReply;
    },
    async updateRule(id: string, input: z.input<typeof autoReplyUpdate>): Promise<AutoReply | null> {
      const patch = autoReplyUpdate.parse(input);
      const current = await getRule(id);
      if (!current) return null;
      const merged = autoReplyCreate.parse({
        name: patch.name ?? current.name, enabled: patch.enabled ?? current.enabled,
        matchType: patch.matchType ?? current.matchType, keywords: patch.keywords ?? current.keywords,
        reply: patch.reply ?? current.reply, cooldownMinutes: patch.cooldownMinutes ?? current.cooldownMinutes,
      });
      await db.prepare(
        `UPDATE whatsapp_auto_replies SET name = ?, enabled = ?, match_type = ?, keywords = ?, reply_type = ?, reply_text = ?,
          template_name = ?, template_language = ?, template_params = ?, cooldown_minutes = ?, updated_at = ? WHERE id = ?`,
      ).bind(...columns(merged), timestamp(clock), id).run();
      return getRule(id);
    },
    async deleteRule(id: string): Promise<void> {
      await db.batch([
        db.prepare("DELETE FROM whatsapp_auto_reply_log WHERE rule_id = ?").bind(id),
        db.prepare("DELETE FROM whatsapp_auto_replies WHERE id = ?").bind(id),
      ]);
    },
    async reorderRules(ids: string[]): Promise<AutoReply[]> {
      const current = (await this.listRules()).map((item) => item.id);
      if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every((id) => current.includes(id))) {
        throw new ConfigOrderError();
      }
      await db.batch(ids.map((id, index) => db.prepare("UPDATE whatsapp_auto_replies SET position = ? WHERE id = ?").bind(index + 1, id)));
      return this.listRules();
    },
    async enabledRules(): Promise<AutoReply[]> {
      const rows = await db.prepare(`${ruleSelect} WHERE r.enabled = 1 ORDER BY r.position, r.created_at, r.id`).all<RuleRow>();
      return rows.results.map(rule);
    },

    /** Claims (rule, inbound message); false when this message was already answered or the customer is cooling down. */
    async claim(ruleId: string, customerId: string, inboundExternalId: string, cooldownMinutes: number): Promise<string | null> {
      const now = clock();
      const since = new Date(now.getTime() - cooldownMinutes * 60_000).toISOString();
      const id = `wal_${crypto.randomUUID()}`;
      const result = await db.prepare(
        `INSERT INTO whatsapp_auto_reply_log (id, rule_id, customer_id, inbound_external_id, status, created_at)
        SELECT ?, ?, ?, ?, 'sent', ? WHERE NOT EXISTS (
          SELECT 1 FROM whatsapp_auto_reply_log WHERE rule_id = ? AND customer_id = ? AND created_at >= ?)
        ON CONFLICT(rule_id, inbound_external_id) DO NOTHING`,
      ).bind(id, ruleId, customerId, inboundExternalId, timestamp(clock), ruleId, customerId, since).run();
      return result.meta.changes > 0 ? id : null;
    },
    async markLogFailed(logId: string): Promise<void> {
      await db.prepare("UPDATE whatsapp_auto_reply_log SET status = 'failed' WHERE id = ?").bind(logId).run();
    },
    async activity(limit = 20): Promise<AutoReplyActivity[]> {
      const rows = await db.prepare(
        `SELECT l.id, r.name AS rule_name, l.customer_id, c.name AS customer_name, l.status, l.created_at
        FROM whatsapp_auto_reply_log l JOIN whatsapp_auto_replies r ON r.id = l.rule_id JOIN customers c ON c.id = l.customer_id
        ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
      ).bind(Math.min(Math.max(limit, 1), 100)).all<{ id: string; rule_name: string; customer_id: string; customer_name: string; status: "sent" | "failed"; created_at: string }>();
      return rows.results.map((row) => ({
        id: row.id, ruleName: row.rule_name, customerId: row.customer_id, customerName: row.customer_name,
        status: row.status, at: row.created_at,
      }));
    },

    async listQuickMessages(): Promise<QuickMessage[]> {
      const rows = await db.prepare("SELECT id, title, text, created_at, updated_at FROM whatsapp_quick_messages ORDER BY title COLLATE NOCASE, id")
        .all<{ id: string; title: string; text: string; created_at: string; updated_at: string }>();
      return rows.results.map((row) => ({ id: row.id, title: row.title, text: row.text, createdAt: row.created_at, updatedAt: row.updated_at }));
    },
    async createQuickMessage(input: z.input<typeof quickMessageCreate>): Promise<QuickMessage> {
      const value = quickMessageCreate.parse(input);
      const id = `wqm_${crypto.randomUUID()}`, now = timestamp(clock);
      const result = await db.prepare(
        `INSERT INTO whatsapp_quick_messages (id, title, text, created_at, updated_at)
        SELECT ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM whatsapp_quick_messages) < ?`,
      ).bind(id, value.title, value.text, now, now, MAX_QUICK_MESSAGES).run();
      if (result.meta.changes === 0) throw new ConfigLimitError();
      return { id, title: value.title, text: value.text, createdAt: now, updatedAt: now };
    },
    async updateQuickMessage(id: string, input: z.input<typeof quickMessageUpdate>): Promise<QuickMessage | null> {
      const patch = quickMessageUpdate.parse(input);
      const row = await db.prepare(
        `UPDATE whatsapp_quick_messages SET title = COALESCE(?, title), text = COALESCE(?, text), updated_at = ?
        WHERE id = ? RETURNING id, title, text, created_at, updated_at`,
      ).bind(patch.title ?? null, patch.text ?? null, timestamp(clock), id)
        .first<{ id: string; title: string; text: string; created_at: string; updated_at: string }>();
      return row ? { id: row.id, title: row.title, text: row.text, createdAt: row.created_at, updatedAt: row.updated_at } : null;
    },
    async deleteQuickMessage(id: string): Promise<void> {
      await db.prepare("DELETE FROM whatsapp_quick_messages WHERE id = ?").bind(id).run();
    },
  };
}
