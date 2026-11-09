import { normalizePhone } from "./customers";
import { type Clock, timestamp } from "./values";

/** Stored in `customers.source`, next to the existing "App" and "whatsapp" values. */
export const BULK_SOURCE = "Bulk import";

/** Most rows one request may carry; the reasoning (Workers free-plan subrequest limit) is in server/README.md. */
export const BULK_MAX_ROWS = 25;

export interface BulkRowInput { name: string; phone: string; notes?: string | undefined; employeeId?: string | undefined }

export type BulkStatus = "created" | "exists" | "invalid" | "duplicate_in_request";
export interface BulkOutcome {
  index: number; status: BulkStatus; customerId?: string; reason?: string; assigned?: boolean;
}
/** A customer this request created, with what the intro message and the push need. */
export interface BulkCreated {
  index: number; id: string; name: string; phone: string;
  /** The employee the row asked for (validated active), or null. */
  employeeId: string | null; assigned: boolean;
}
/** An active employee named by a row; `phone` is the number shown as `handler_phone`. */
export interface BulkEmployee { id: string; name: string; phone: string }

const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(",");

/**
 * Creates the customers of a bulk request. Existing customers (same last ten digits, archived ones excluded, exactly like the
 * unique index) are reported and never touched. All new rows go in one D1 batch, which is one transaction: each row's assignment
 * only inserts when its customer row was inserted, and a row that lost a race for its phone number inserts nothing.
 */
export async function importCustomers(
  db: D1Database, rows: BulkRowInput[], clock: Clock = () => new Date(),
): Promise<{ results: BulkOutcome[]; created: BulkCreated[]; employees: Map<string, BulkEmployee> }> {
  const results: BulkOutcome[] = rows.map((_, index) => ({ index, status: "invalid" }));
  const candidates: { index: number; name: string; phone: string; phoneKey: string; notes: string | null; employeeId: string | null }[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const name = row.name.replace(/\s+/g, " ").trim();
    const phone = normalizePhone(row.phone.length > 64 ? "" : row.phone);
    const notes = row.notes?.trim() || null;
    const reason = name === "" ? "name_required" : name.length > 200 ? "name_too_long"
      : !phone ? "invalid_phone" : notes && notes.length > 4000 ? "notes_too_long" : null;
    if (reason || !phone) {
      results[index] = { index, status: "invalid", reason: reason ?? "invalid_phone" };
    } else if (seen.has(phone.phoneKey)) {
      results[index] = { index, status: "duplicate_in_request", reason: "duplicate_phone" };
    } else {
      seen.add(phone.phoneKey);
      candidates.push({ index, name, phone: phone.phone, phoneKey: phone.phoneKey, notes, employeeId: row.employeeId?.trim() || null });
    }
  });

  const existing = new Map<string, string>();
  if (candidates.length > 0) {
    const found = await db.prepare(
      `SELECT id, phone_key FROM customers WHERE archived_at IS NULL AND phone_key IN (${placeholders(candidates.length)})`,
    ).bind(...candidates.map((row) => row.phoneKey)).all<{ id: string; phone_key: string }>();
    for (const row of found.results) existing.set(row.phone_key, row.id);
  }
  const fresh = candidates.filter((row) => {
    const id = existing.get(row.phoneKey);
    if (id) results[row.index] = { index: row.index, status: "exists", customerId: id };
    return !id;
  });

  const employees = new Map<string, BulkEmployee>();
  const wanted = [...new Set(fresh.flatMap((row) => (row.employeeId ? [row.employeeId] : [])))];
  if (wanted.length > 0) {
    const found = await db.prepare(
      `SELECT id, name, phone_number FROM employees WHERE active = 1 AND id IN (${placeholders(wanted.length)})`,
    ).bind(...wanted).all<{ id: string; name: string; phone_number: string | null }>();
    for (const row of found.results) employees.set(row.id, { id: row.id, name: row.name, phone: row.phone_number ?? "" });
  }
  const insertable = fresh.filter((row) => {
    const bad = row.employeeId !== null && !employees.has(row.employeeId);
    if (bad) results[row.index] = { index: row.index, status: "invalid", reason: "invalid_employee" };
    return !bad;
  });
  if (insertable.length === 0) return { results, created: [], employees };

  const now = timestamp(clock);
  const planned = insertable.map((row) => ({ ...row, id: `cus_${crypto.randomUUID()}` }));
  const answers = await db.batch<{ id?: string; customer_id?: string }>(planned.flatMap((row) => [
    db.prepare(
      `INSERT INTO customers (id, name, phone, phone_key, notes, source, country, created_at, updated_at, created_by_employee_id)
      VALUES (?, ?, ?, ?, ?, ?, 'India', ?, ?, NULL) ON CONFLICT DO NOTHING RETURNING id`,
    ).bind(row.id, row.name, row.phone, row.phoneKey, row.notes, BULK_SOURCE, now, now),
    // Inserts nothing when the customer row above was skipped, so a lost race leaves no stray assignment.
    db.prepare(
      `INSERT INTO customer_employees (customer_id, employee_id, assigned_at)
      SELECT c.id, e.id, ? FROM customers c, employees e WHERE c.id = ? AND e.id = ? AND e.active = 1 RETURNING customer_id`,
    ).bind(now, row.id, row.employeeId ?? ""),
  ]));

  const created: BulkCreated[] = [];
  const raced: typeof planned = [];
  planned.forEach((row, position) => {
    if ((answers[position * 2]?.results.length ?? 0) === 0) {
      raced.push(row);
      return;
    }
    const assigned = (answers[position * 2 + 1]?.results.length ?? 0) > 0;
    results[row.index] = { index: row.index, status: "created", customerId: row.id, assigned };
    created.push({ index: row.index, id: row.id, name: row.name, phone: row.phone, employeeId: row.employeeId, assigned });
  });
  if (raced.length > 0) {
    const found = await db.prepare(
      `SELECT id, phone_key FROM customers WHERE archived_at IS NULL AND phone_key IN (${placeholders(raced.length)})`,
    ).bind(...raced.map((row) => row.phoneKey)).all<{ id: string; phone_key: string }>();
    const byKey = new Map(found.results.map((row) => [row.phone_key, row.id]));
    for (const row of raced) {
      const id = byKey.get(row.phoneKey);
      results[row.index] = id ? { index: row.index, status: "exists", customerId: id } : { index: row.index, status: "invalid", reason: "not_saved" };
    }
  }
  return { results, created, employees };
}
