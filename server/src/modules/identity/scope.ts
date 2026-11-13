import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

import { loadEmployeeScope, type EmployeeScope } from "../../data/scope";
import { ApiError } from "../../http/errors";

/** The signed-in employee's scope, loaded once per request. */
export async function employeeScope(context: Context<any>): Promise<EmployeeScope> {
  const cached = context.get("employeeScope") as EmployeeScope | undefined;
  if (cached) return cached;
  const loaded = await loadEmployeeScope(context.env.DB, (context.get("device") as { employeeId: string }).employeeId);
  if (!loaded) throw new HTTPException(401, { message: "Device authentication required" });
  context.set("employeeScope", loaded);
  return loaded;
}

export const notAManager = () => new ApiError(400, "not_a_manager", "This option is only available to managers");
export const outOfScope = () => new ApiError(400, "employee_out_of_scope", "That employee is not you or on your team");

export async function requireManagerScope(context: Context<any>): Promise<EmployeeScope> {
  const scope = await employeeScope(context);
  if (scope.role !== "manager") throw notAManager();
  return scope;
}

/**
 * The employees an `employeeId=<id|me|team>` filter selects, within the scope. Absent: the whole scope. A non-manager
 * may not send it at all; an id outside the scope is refused.
 */
export function narrowEmployees(scope: EmployeeScope, filter: string | undefined): string[] {
  if (filter === undefined) return scope.employeeIds;
  if (scope.role !== "manager") throw notAManager();
  if (filter === "me") return [scope.selfId];
  if (filter === "team") return scope.team.map((member) => member.id);
  if (!scope.employeeIds.includes(filter)) throw outOfScope();
  return [filter];
}

/** Removes `key` from parsed query values, returning its value; lets strict per-route schemas stay unchanged. */
export function takeQueryValue(values: Record<string, string>, key: string): { rest: Record<string, string>; value: string | undefined } {
  const rest: Record<string, string> = Object.create(null);
  let value: string | undefined;
  for (const [name, entry] of Object.entries(values)) {
    if (name === key) value = entry;
    else rest[name] = entry;
  }
  return { rest, value };
}

/** What a client gets of the signed-in employee's place in the organisation. */
export function profileExtras(scope: EmployeeScope) {
  return {
    role: scope.role,
    managerId: scope.managerId,
    team: scope.team.map((member) => ({ id: member.id, name: member.name, phoneNumber: member.phoneNumber })),
  };
}

/** `scope:'own'|'team'` on a customer or chat for a manager: 'own' when the manager is one of the handlers. */
export function withScopeLabel<T extends { employees: { id: string }[] }>(scope: EmployeeScope, item: T): T & { scope?: "own" | "team" } {
  if (scope.role !== "manager") return item;
  return { ...item, scope: item.employees.some((employee) => employee.id === scope.selfId) ? "own" : "team" };
}
