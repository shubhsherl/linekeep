/**
 * Who an employee-facing request may see. Resolved once per request from the signed-in employee:
 * - an employee sees only themselves (`employeeIds = [selfId]`);
 * - a manager sees themselves and their active reports (single level: a team is the active employees whose
 *   `manager_id` is the manager).
 * Every employee-facing query binds `employeeIds` in SQL; nothing is filtered after fetching.
 */
export interface TeamMember { id: string; name: string; phoneNumber: string | null }

export interface EmployeeScope {
  selfId: string;
  role: "employee" | "manager";
  /** The employee's own manager (reports only; null for managers and unmanaged employees). */
  managerId: string | null;
  /** Self first, then the active reports (managers only). */
  employeeIds: string[];
  /** Active reports ordered by name; empty for non-managers. */
  team: TeamMember[];
  /** Names of everyone in scope, for response bodies. */
  names: Map<string, string>;
}

/** A manager can have at most this many active reports (keeps every scope predicate within D1's bind limit). */
export const MAX_TEAM_SIZE = 50;

type Row = {
  id: string; name: string; phone_number: string | null; role: "employee" | "manager"; manager_id: string | null;
};

/** One query: the employee and (for a manager) their active reports. Null when the employee does not exist. */
export async function loadEmployeeScope(db: D1Database, employeeId: string): Promise<EmployeeScope | null> {
  const rows = await db.prepare(
    `SELECT id, name, phone_number, role, manager_id FROM employees
      WHERE id = ?1 OR (manager_id = ?1 AND active = 1 AND EXISTS (SELECT 1 FROM employees m WHERE m.id = ?1 AND m.role = 'manager'))
      ORDER BY name, id`,
  ).bind(employeeId).all<Row>();
  const self = rows.results.find((row) => row.id === employeeId);
  if (!self) return null;
  const team = self.role === "manager"
    ? rows.results.filter((row) => row.id !== employeeId).map((row) => ({ id: row.id, name: row.name, phoneNumber: row.phone_number }))
    : [];
  return {
    selfId: self.id,
    role: self.role,
    managerId: self.manager_id,
    employeeIds: [self.id, ...team.map((member) => member.id)],
    team,
    names: new Map([[self.id, self.name], ...team.map((member): [string, string] => [member.id, member.name])]),
  };
}

export const isManager = (scope: EmployeeScope): boolean => scope.role === "manager";
