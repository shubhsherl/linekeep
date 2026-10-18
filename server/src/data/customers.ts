import { z } from "zod";

import { adminCallDto, call, type AdminCall, type CallRow } from "./calls";
import { callHistoryCursor, type CallHistoryItem } from "./call-history";
import { type Clock, timestamp } from "./values";

const boundedId = z.string().min(1).max(256);

/**
 * The one phone normalization used for input, storage and call matching.
 * Ten digits and a leading-zero eleven digits are Indian numbers; anything else
 * keeps its digits. `phoneKey` is the last ten digits (fewer for short numbers).
 */
export function normalizePhone(value: string): { phone: string; phoneKey: string } | null {
  const digits = value.replace(/\D/g, "");
  const normalized = digits.length === 10
    ? `91${digits}`
    : digits.length === 11 && digits.startsWith("0") ? `91${digits.slice(1)}` : digits;
  if (normalized.length < 8 || normalized.length > 15) return null;
  return { phone: `+${normalized}`, phoneKey: normalized.slice(-10) };
}

const phoneInput = z.string().min(1).max(64).transform((value, context) => {
  const normalized = normalizePhone(value);
  if (!normalized) {
    context.addIssue({ code: "custom", message: "Invalid phone number" });
    return z.NEVER;
  }
  return normalized;
});

// Blank strings clear an optional field; stored and returned values are never "".
const optionalText = (max: number) => z.string().trim().max(max)
  .transform((value) => (value === "" ? null : value)).nullable();
const optionalEmail = z.string().trim().max(254)
  .transform((value) => (value === "" ? null : value))
  .pipe(z.email().nullable()).nullable();
const name = z.string().trim().min(1).max(200);
const employeeIds = z.array(boundedId).max(50);

export const customerCreateInput = z.strictObject({
  name,
  phone: phoneInput,
  email: optionalEmail.optional(),
  notes: optionalText(4000).optional(),
  source: optionalText(120).optional(),
  district: optionalText(120).optional(),
  state: optionalText(120).optional(),
  country: optionalText(120).optional(),
  employeeIds: employeeIds.optional(),
});
export const customerUpdateInput = z.strictObject({
  name: name.optional(),
  phone: phoneInput.optional(),
  email: optionalEmail.optional(),
  notes: optionalText(4000).optional(),
  source: optionalText(120).optional(),
  district: optionalText(120).optional(),
  state: optionalText(120).optional(),
  country: optionalText(120).optional(),
}).refine((value) => Object.values(value).some((field) => field !== undefined));
export const customerEmployeesInput = z.strictObject({ employeeIds });
export const whatsappSendInput = z.strictObject({
  clientMessageId: z.uuid(),
  text: z.string().min(1).max(4096),
});

const limit = z.number().int().min(1).max(100).default(50);
const search = z.string().trim().min(1).max(200);
const pageInput = z.strictObject({ cursor: callHistoryCursor.optional(), limit });
const listInput = z.strictObject({
  q: search.optional(),
  employeeId: boundedId.optional(),
  unassigned: z.boolean().optional(),
  source: z.string().trim().min(1).max(120).optional(),
  state: z.string().trim().min(1).max(120).optional(),
  cursor: callHistoryCursor.optional(),
  limit,
}).refine((value) => !(value.unassigned && value.employeeId !== undefined));
const chatInput = z.strictObject({
  q: search.optional(),
  employeeId: boundedId.optional(),
  cursor: callHistoryCursor.optional(),
  limit,
});

export type CustomerCursor = z.infer<typeof callHistoryCursor>;
/** Restricts reads to customers assigned to this employee (device access). */
export interface CustomerScope { employeeId: string }

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email?: string;
  notes?: string;
  source?: string;
  district?: string;
  state?: string;
  country: string;
  employees: { id: string; name: string }[];
  messageCount: number;
  lastMessageAt?: string;
  lastCallAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface WhatsAppMessage {
  id: string;
  customerId: string;
  direction: "in" | "out";
  messageType: string;
  body?: string;
  mediaUrl?: string;
  templateName?: string;
  status: "queued" | "sent" | "delivered" | "read" | "failed";
  fromNumber?: string;
  toNumber?: string;
  sentAt: string;
  deliveredAt?: string;
  readAt?: string;
  sentBy?: { id: string; name: string };
}
export interface ChatSummary {
  customer: { id: string; name: string; phone: string };
  employees: { id: string; name: string }[];
  lastMessage: { direction: "in" | "out"; messageType: string; text: string; sentAt: string };
  messageCount: number;
}
export interface CustomerPage<T> { items: T[]; nextCursor: CustomerCursor | null }

export class CustomerPhoneExistsError extends Error {}
/** An employee in the requested set does not exist or is inactive. */
export class CustomerAssignmentError extends Error {}

type CustomerRow = {
  id: string; name: string; phone: string; email: string | null; notes: string | null;
  source: string | null; district: string | null; state: string | null; country: string;
  created_at: string; updated_at: string; message_count: number;
  last_message_at: string | null; last_call_at: string | null; employees: string;
};
type MessageRow = {
  id: string; customer_id: string; direction: WhatsAppMessage["direction"]; message_type: string;
  body: string | null; media_url: string | null; template_name: string | null;
  status: WhatsAppMessage["status"]; from_number: string | null; to_number: string | null;
  sent_at: string; delivered_at: string | null; read_at: string | null;
  sent_by_employee_id: string | null; sent_by_name: string | null;
};
type ChatRow = {
  id: string; name: string; phone: string; direction: WhatsAppMessage["direction"];
  message_type: string; text: string; sent_at: string; message_count: number; employees: string;
};
type CallFeedRow = CallRow & {
  feed_id: string; feed_device_id: string; feed_employee_id: string; employee_name: string;
  feed_started_at: string; feed_duration_seconds: number; call_type: CallHistoryItem["callType"];
  feed_remote_number: string | null; caller_name: string | null; local_number: string | null;
  sim_label: string | null; phone_account_id: string | null; feed_created_at: string;
};

const employeesJson = `(SELECT json_group_array(json_object('id', x.id, 'name', x.name))
  FROM (SELECT e.id, e.name FROM customer_employees ce JOIN employees e ON e.id = ce.employee_id
    WHERE ce.customer_id = c.id ORDER BY e.name, e.id) x)`;
const messageCount = "(SELECT count(*) FROM whatsapp_messages m WHERE m.customer_id = c.id)";
const customerSelect = `SELECT c.id, c.name, c.phone, c.email, c.notes, c.source, c.district,
  c.state, c.country, c.created_at, c.updated_at, ${messageCount} AS message_count,
  (SELECT m.sent_at FROM whatsapp_messages m WHERE m.customer_id = c.id
    ORDER BY m.sent_at DESC, m.id DESC LIMIT 1) AS last_message_at,
  (SELECT h.started_at FROM call_logs h WHERE h.phone_key = c.phone_key AND h.deleted_at IS NULL
    ORDER BY h.started_at DESC, h.id DESC LIMIT 1) AS last_call_at,
  ${employeesJson} AS employees
  FROM customers c`;
const assigned = (binding: string) =>
  `EXISTS (SELECT 1 FROM customer_employees s WHERE s.customer_id = c.id AND s.employee_id = ${binding})`;

function customer(row: CustomerRow): Customer {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email ?? undefined,
    notes: row.notes ?? undefined,
    source: row.source ?? undefined,
    district: row.district ?? undefined,
    state: row.state ?? undefined,
    country: row.country,
    employees: JSON.parse(row.employees) as Customer["employees"],
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at ?? undefined,
    lastCallAt: row.last_call_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function message(row: MessageRow): WhatsAppMessage {
  return {
    id: row.id,
    customerId: row.customer_id,
    direction: row.direction,
    messageType: row.message_type,
    body: row.body ?? undefined,
    // Imported URLs are untrusted text; only hand clients https links.
    mediaUrl: row.media_url !== null && /^https:\/\//i.test(row.media_url) ? row.media_url : undefined,
    templateName: row.template_name ?? undefined,
    status: row.status,
    fromNumber: row.from_number ?? undefined,
    toNumber: row.to_number ?? undefined,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at ?? undefined,
    readAt: row.read_at ?? undefined,
    sentBy: row.sent_by_employee_id && row.sent_by_name !== null
      ? { id: row.sent_by_employee_id, name: row.sent_by_name } : undefined,
  };
}

/** Literal, case-insensitive matching: `instr` never interprets wildcards. */
function searchCondition(q: string, bindings: (string | number)[]): string {
  const clauses = [
    "instr(lower(c.name), lower(?)) > 0",
    "instr(lower(coalesce(c.email, '')), lower(?)) > 0",
  ];
  bindings.push(q, q);
  const digits = q.replace(/\D/g, "");
  if (digits !== "" && /^[\d\s+()\-.]+$/.test(q)) {
    clauses.push("instr(c.phone, ?) > 0");
    bindings.push(digits);
  }
  return `(${clauses.join(" OR ")})`;
}

function paged<T>(
  items: T[], pageSize: number, cursorOf: (item: T) => CustomerCursor,
): CustomerPage<T> {
  const hasMore = items.length > pageSize;
  if (hasMore) items.pop();
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? cursorOf(last) : null };
}

export function createCustomerRepository(db: D1Database, clock: Clock = () => new Date()) {
  async function find(customerId: string, scope?: CustomerScope): Promise<Customer | null> {
    const row = await db.prepare(
      `${customerSelect} WHERE c.id = ? AND c.archived_at IS NULL
        ${scope ? `AND ${assigned("?")}` : ""}`,
    ).bind(boundedId.parse(customerId), ...(scope ? [scope.employeeId] : []))
      .first<CustomerRow>();
    return row ? customer(row) : null;
  }

  async function visible(customerId: string, scope?: CustomerScope): Promise<boolean> {
    const row = await db.prepare(
      `SELECT 1 AS found FROM customers c WHERE c.id = ? AND c.archived_at IS NULL
        ${scope ? `AND ${assigned("?")}` : ""}`,
    ).bind(boundedId.parse(customerId), ...(scope ? [scope.employeeId] : []))
      .first<{ found: number }>();
    return row !== null;
  }

  /** Active employees, plus any already assigned to this customer (kept, never newly added). */
  async function assertAssignable(customerId: string | null, ids: string[]) {
    if (ids.length === 0) return;
    const rows = await db.prepare(
      `SELECT e.id FROM employees e WHERE e.id IN (${ids.map(() => "?").join(", ")})
        AND (e.active = 1 OR EXISTS (SELECT 1 FROM customer_employees ce
          WHERE ce.customer_id = ? AND ce.employee_id = e.id))`,
    ).bind(...ids, customerId ?? "").all<{ id: string }>();
    if (rows.results.length !== ids.length) throw new CustomerAssignmentError();
  }

  const assignStatement = (customerId: string, employeeId: string, now: string) => db.prepare(
    `INSERT INTO customer_employees (customer_id, employee_id, assigned_at)
      SELECT ?, e.id, ? FROM employees e WHERE e.id = ? AND (e.active = 1 OR EXISTS (
        SELECT 1 FROM customer_employees ce WHERE ce.customer_id = ? AND ce.employee_id = e.id))
      ON CONFLICT(customer_id, employee_id) DO NOTHING`,
  ).bind(customerId, now, employeeId, customerId);

  async function guardUnique<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")
        && error.message.includes("customers.phone_key")) {
        throw new CustomerPhoneExistsError();
      }
      throw error;
    }
  }

  return {
    async createCustomer(input: z.input<typeof customerCreateInput>): Promise<Customer> {
      const value = customerCreateInput.parse(input);
      const ids = [...new Set(value.employeeIds ?? [])];
      await assertAssignable(null, ids);
      const customerId = `cus_${crypto.randomUUID()}`;
      const now = timestamp(clock);
      await guardUnique(() => db.batch([
        db.prepare(
          `INSERT INTO customers (id, name, phone, phone_key, email, notes, source, district,
            state, country, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'India'), ?, ?)`,
        ).bind(customerId, value.name, value.phone.phone, value.phone.phoneKey,
          value.email ?? null, value.notes ?? null, value.source ?? null,
          value.district ?? null, value.state ?? null, value.country ?? null, now, now),
        ...ids.map((employeeId) => assignStatement(customerId, employeeId, now)),
      ]));
      const created = await find(customerId);
      if (!created) throw new Error("Customer write returned no row");
      return created;
    },

    getCustomer: find,

    async listCustomers(
      input: z.input<typeof listInput> = {}, scope?: CustomerScope,
    ): Promise<CustomerPage<Customer>> {
      const value = listInput.parse(input);
      const conditions = ["c.archived_at IS NULL"];
      const bindings: (string | number)[] = [];
      if (scope) {
        conditions.push(assigned("?"));
        bindings.push(scope.employeeId);
      }
      if (value.q !== undefined) conditions.push(searchCondition(value.q, bindings));
      if (value.employeeId !== undefined) {
        conditions.push(assigned("?"));
        bindings.push(value.employeeId);
      }
      if (value.unassigned) {
        conditions.push("NOT EXISTS (SELECT 1 FROM customer_employees s WHERE s.customer_id = c.id)");
      }
      if (value.source !== undefined) {
        conditions.push("lower(c.source) = lower(?)");
        bindings.push(value.source);
      }
      if (value.state !== undefined) {
        conditions.push("lower(c.state) = lower(?)");
        bindings.push(value.state);
      }
      if (value.cursor) {
        conditions.push("(c.updated_at, c.id) < (?, ?)");
        bindings.push(value.cursor.sortAt, value.cursor.id);
      }
      const rows = await db.prepare(
        `${customerSelect} WHERE ${conditions.join(" AND ")}
          ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
      ).bind(...bindings, value.limit + 1).all<CustomerRow>();
      return paged(rows.results.map(customer), value.limit,
        (item) => ({ sortAt: item.updatedAt, id: item.id }));
    },

    /** Returns null for an unknown or archived customer. */
    async updateCustomer(
      customerId: string, input: z.input<typeof customerUpdateInput>,
    ): Promise<Customer | null> {
      const value = customerUpdateInput.parse(input);
      const sets: string[] = [];
      const bindings: (string | null)[] = [];
      const set = (column: string, field: string | null | undefined) => {
        if (field === undefined) return;
        sets.push(`${column} = ?`);
        bindings.push(field);
      };
      set("name", value.name);
      if (value.phone !== undefined) {
        set("phone", value.phone.phone);
        set("phone_key", value.phone.phoneKey);
      }
      set("email", value.email);
      set("notes", value.notes);
      set("source", value.source);
      set("district", value.district);
      set("state", value.state);
      // Country is always present; clearing it restores the default.
      if (value.country !== undefined) {
        sets.push("country = COALESCE(?, 'India')");
        bindings.push(value.country);
      }
      const updated = await guardUnique(() => db.prepare(
        `UPDATE customers SET ${sets.join(", ")}, updated_at = ?
          WHERE id = ? AND archived_at IS NULL RETURNING id`,
      ).bind(...bindings, timestamp(clock), boundedId.parse(customerId)).first<{ id: string }>());
      return updated ? find(customerId) : null;
    },

    /** Replaces the handler set. Returns null for an unknown or archived customer. */
    async setCustomerEmployees(customerId: string, ids: string[]): Promise<Customer | null> {
      const requested = [...new Set(customerEmployeesInput.parse({ employeeIds: ids }).employeeIds)];
      if (!(await visible(customerId))) return null;
      await assertAssignable(customerId, requested);
      const now = timestamp(clock);
      await db.batch([
        db.prepare(
          `DELETE FROM customer_employees WHERE customer_id = ?
            ${requested.length ? `AND employee_id NOT IN (${requested.map(() => "?").join(", ")})` : ""}`,
        ).bind(customerId, ...requested),
        ...requested.map((employeeId) => assignStatement(customerId, employeeId, now)),
        db.prepare("UPDATE customers SET updated_at = ? WHERE id = ?").bind(now, customerId),
      ]);
      return find(customerId);
    },

    /** Idempotent; messages are kept. False only when the customer never existed. */
    async archiveCustomer(customerId: string): Promise<boolean> {
      const now = timestamp(clock);
      const row = await db.prepare(
        `UPDATE customers SET archived_at = COALESCE(archived_at, ?),
          updated_at = CASE WHEN archived_at IS NULL THEN ? ELSE updated_at END
          WHERE id = ? RETURNING id`,
      ).bind(now, now, boundedId.parse(customerId)).first<{ id: string }>();
      return row !== null;
    },

    /** Null when the customer is unknown, archived or (with a scope) not assigned. */
    async listMessages(
      customerId: string, input: z.input<typeof pageInput> = {}, scope?: CustomerScope,
    ): Promise<CustomerPage<WhatsAppMessage> | null> {
      const value = pageInput.parse(input);
      if (!(await visible(customerId, scope))) return null;
      const rows = await db.prepare(
        `SELECT m.id, m.customer_id, m.direction, m.message_type, m.body, m.media_url,
          m.template_name, m.status, m.from_number, m.to_number, m.sent_at, m.delivered_at,
          m.read_at, m.sent_by_employee_id, e.name AS sent_by_name
        FROM whatsapp_messages m LEFT JOIN employees e ON e.id = m.sent_by_employee_id
        WHERE m.customer_id = ? ${value.cursor ? "AND (m.sent_at, m.id) < (?, ?)" : ""}
        ORDER BY m.sent_at DESC, m.id DESC LIMIT ?`,
      ).bind(customerId, ...(value.cursor ? [value.cursor.sortAt, value.cursor.id] : []),
        value.limit + 1).all<MessageRow>();
      return paged(rows.results.map(message), value.limit,
        (item) => ({ sortAt: item.sentAt, id: item.id }));
    },

    /**
     * Matched, undeleted call-log rows from any employee or device, with their recordings in
     * the unified feed's kind:"call" representation. Null for an unknown or archived customer.
     */
    async listCustomerCalls(
      customerId: string, input: z.input<typeof pageInput> = {},
    ): Promise<CustomerPage<CallHistoryItem> | null> {
      const value = pageInput.parse(input);
      const target = await db.prepare(
        "SELECT phone_key FROM customers WHERE id = ? AND archived_at IS NULL",
      ).bind(boundedId.parse(customerId)).first<{ phone_key: string }>();
      if (!target) return null;
      // Call keys are always ten digits; shorter customer keys can never match.
      if (target.phone_key.length < 10) return { items: [], nextCursor: null };
      const rows = await db.prepare(`
        WITH page AS (
          SELECT h.id, h.device_id, h.employee_id, h.started_at, h.duration_seconds, h.call_type,
            h.remote_number, h.caller_name, h.local_number, h.sim_label, h.phone_account_id, h.created_at
          FROM call_logs h WHERE h.phone_key = ? AND h.deleted_at IS NULL
            ${value.cursor ? "AND (h.started_at, h.id) < (?, ?)" : ""}
          ORDER BY h.started_at DESC, h.id DESC LIMIT ?
        )
        SELECT r.*, p.id AS feed_id, p.device_id AS feed_device_id,
          p.employee_id AS feed_employee_id, e.name AS employee_name,
          p.started_at AS feed_started_at, p.duration_seconds AS feed_duration_seconds,
          p.call_type, p.remote_number AS feed_remote_number, p.caller_name, p.local_number,
          p.sim_label, p.phone_account_id, p.created_at AS feed_created_at
        FROM page p JOIN employees e ON e.id = p.employee_id
        LEFT JOIN calls r ON r.upload_status <> 'deleted' AND r.call_log_id = p.id
        ORDER BY p.started_at DESC, p.id DESC, r.created_at DESC, r.id DESC
      `).bind(target.phone_key, ...(value.cursor ? [value.cursor.sortAt, value.cursor.id] : []),
        value.limit + 1).all<CallFeedRow>();
      const items: CallHistoryItem[] = [];
      for (const row of rows.results) {
        if (items.at(-1)?.id !== row.feed_id) {
          items.push({
            kind: "call",
            id: row.feed_id,
            deviceId: row.feed_device_id,
            employee: { id: row.feed_employee_id, name: row.employee_name },
            startedAt: row.feed_started_at,
            durationSeconds: row.feed_duration_seconds,
            callType: row.call_type,
            remoteNumber: row.feed_remote_number ?? undefined,
            callerName: row.caller_name ?? undefined,
            localNumber: row.local_number ?? undefined,
            simLabel: row.sim_label ?? undefined,
            phoneAccountId: row.phone_account_id ?? undefined,
            recordings: [] as AdminCall[],
            createdAt: row.feed_created_at,
          });
        }
        if (row.id) items.at(-1)!.recordings.push(adminCallDto({
          ...call(row), employee: { id: row.feed_employee_id, name: row.employee_name },
        }));
      }
      return paged(items, value.limit, (item) => ({ sortAt: item.startedAt, id: item.id }));
    },

    /** One row per customer with messages, newest conversation first. */
    async listChats(
      input: z.input<typeof chatInput> = {}, scope?: CustomerScope,
    ): Promise<CustomerPage<ChatSummary>> {
      const value = chatInput.parse(input);
      const conditions = ["c.archived_at IS NULL"];
      const bindings: (string | number)[] = [];
      if (scope) {
        conditions.push(assigned("?"));
        bindings.push(scope.employeeId);
      }
      if (value.q !== undefined) conditions.push(searchCondition(value.q, bindings));
      if (value.employeeId !== undefined) {
        conditions.push(assigned("?"));
        bindings.push(value.employeeId);
      }
      if (value.cursor) {
        conditions.push("(m.sent_at, c.id) < (?, ?)");
        bindings.push(value.cursor.sortAt, value.cursor.id);
      }
      const rows = await db.prepare(
        `SELECT c.id, c.name, c.phone, m.direction, m.message_type,
          substr(coalesce(m.body, ''), 1, 200) AS text, m.sent_at,
          ${messageCount} AS message_count, ${employeesJson} AS employees
        FROM customers c JOIN whatsapp_messages m ON m.id = (
          SELECT l.id FROM whatsapp_messages l WHERE l.customer_id = c.id
          ORDER BY l.sent_at DESC, l.id DESC LIMIT 1)
        WHERE ${conditions.join(" AND ")}
        ORDER BY m.sent_at DESC, c.id DESC LIMIT ?`,
      ).bind(...bindings, value.limit + 1).all<ChatRow>();
      const chats = rows.results.map((row) => ({
        cursor: { sortAt: row.sent_at, id: row.id },
        chat: {
          customer: { id: row.id, name: row.name, phone: row.phone },
          employees: JSON.parse(row.employees) as ChatSummary["employees"],
          lastMessage: {
            direction: row.direction, messageType: row.message_type, text: row.text,
            sentAt: row.sent_at,
          },
          messageCount: row.message_count,
        } satisfies ChatSummary,
      }));
      const result = paged(chats, value.limit, (item) => item.cursor);
      return { items: result.items.map((item) => item.chat), nextCursor: result.nextCursor };
    },
  };
}
