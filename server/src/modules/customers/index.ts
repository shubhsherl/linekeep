import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { recordActivity, requestActor } from "../../activity/record";
import type { AppBindings } from "../../app";
import { callHistoryCursor } from "../../data/call-history";
import {
  CustomerAssignmentError,
  deviceCustomerCreateInput,
  deviceCustomerUpdateInput,
  normalizePhone,
  CustomerPhoneExistsError,
  createCustomerRepository,
  customerEmployeesInput,
  type Customer,
  type CustomerCursor,
  type CustomerScope,
} from "../../data/customers";
import type { Env } from "../../env";
import { defer } from "../../http/defer";
import { notifyAssigned } from "../../push/notify";
import { ApiError } from "../../http/errors";
import { requireFeature } from "../../settings/gate";
import { BULK_BODY_LIMIT, bulkCreateCustomers } from "./bulk";
import { createWhatsAppReadRepository } from "../../data/whatsapp-reads";
import { isManager, type EmployeeScope } from "../../data/scope";
import { deviceAccess, type DeviceBindings, type EmployeeAccess } from "../identity";
import {
  employeeScope, narrowEmployees, notAManager, outOfScope, requireManagerScope, takeQueryValue, withScopeLabel,
} from "../identity/scope";
import type { AttachmentOwner } from "../../data/whatsapp-attachments";
import { whatsappSendInput } from "../../data/whatsapp-send";
import {
  sendToCustomer, whatsappCanSend, AttachmentNotFoundError, TemplateHeaderRequiredError, UnsupportedAttachmentError,
  WhatsAppSendFailedError, WhatsAppUnavailableError, WhatsAppWindowClosedError,
} from "../whatsapp/send";

const customerId = z.string().min(1).max(256);
const booleanFlag = z.enum(["true", "false"]).transform((value) => value === "true");
const cursor = z.string().min(1).max(2048);
const limit = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100));
const search = z.string().max(200);
const pageQuery = z.strictObject({ cursor: cursor.optional(), limit: limit.optional() });
const adminListQuery = z.strictObject({
  q: search.optional(),
  employeeId: z.string().min(1).max(256).optional(),
  unassigned: booleanFlag.optional(),
  source: z.string().max(120).optional(),
  state: z.string().max(120).optional(),
  cursor: cursor.optional(),
  limit: limit.optional(),
});
const adminChatQuery = z.strictObject({
  q: search.optional(),
  employeeId: z.string().min(1).max(256).optional(),
  cursor: cursor.optional(),
  limit: limit.optional(),
});
const deviceListQuery = z.strictObject({
  q: search.optional(), cursor: cursor.optional(), limit: limit.optional(),
});

type ListQuery = z.infer<typeof adminListQuery> | z.infer<typeof deviceListQuery>;

function queryValues(url: string) {
  const values: Record<string, string> = Object.create(null);
  for (const [key, value] of new URL(url).searchParams) {
    if (Object.hasOwn(values, key)) {
      throw new HTTPException(400, { message: "Invalid query parameters" });
    }
    values[key] = value;
  }
  for (const key of Object.keys(values)) {
    if (values[key] === "") delete values[key];
  }
  return values;
}

function encodeCursor(value: CustomerCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(encoded: string): CustomerCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const bytes = Uint8Array.from(
      atob(encoded.replaceAll("-", "+").replaceAll("_", "/")),
      (character) => character.charCodeAt(0),
    );
    const decoded = callHistoryCursor.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (encodeCursor(decoded) !== encoded) throw new Error();
    return decoded;
  } catch {
    throw new HTTPException(400, { message: "Invalid pagination cursor" });
  }
}

/** Decodes the opaque cursor in a parsed query so the repository receives the structured form. */
function withCursor<T extends { cursor?: string }>(query: T) {
  return { ...query, cursor: query.cursor ? decodeCursor(query.cursor) : undefined };
}

function pageBody(requestId: string, page: { nextCursor: CustomerCursor | null }) {
  return { requestId, nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null };
}

const customerFields = ["name", "phone", "email", "notes", "source", "district", "state", "country"] as const;

/** Names of the fields that differ: what the log keeps of an edit, never the values. */
function changedFields(before: Customer, after: Customer): string[] {
  return customerFields.filter((field) => before[field] !== after[field]);
}

const targetOf = (customer: { id: string; name: string }) => ({ type: "customer" as const, id: customer.id, label: customer.name });

/** What a request may see: the customers it can reach and how customer items are labelled for it. */
interface ReadAccess {
  scope?: CustomerScope;
  decorate<T extends { employees: { id: string }[] }>(item: T): T;
}

/** The shared handlers only differ in who may see which customer. */
function customerReadRoutes<B extends AppBindings>(
  resolve: (context: Context<B>) => Promise<ReadAccess>,
  parseList: (url: string) => ListQuery,
  /** The query of the message list; employee-facing routes remove their `employeeId` filter first. */
  messageQuery: (url: string) => Record<string, string> = queryValues,
) {
  const routes = new Hono<B>();
  routes.get("/customers", async (context) => {
    const access = await resolve(context);
    const page = await createCustomerRepository(context.env.DB).listCustomers(
      withCursor(parseList(context.req.url)), access.scope,
    );
    return context.json({ ...pageBody(context.get("requestId"), page), items: page.items.map((item) => access.decorate(item)) });
  });
  routes.get("/customers/:customerId", async (context) => {
    const access = await resolve(context);
    const found = await createCustomerRepository(context.env.DB).getCustomer(
      customerId.parse(context.req.param("customerId")), access.scope,
    );
    if (!found) throw new HTTPException(404, { message: "Customer not found" });
    return context.json({ requestId: context.get("requestId"), customer: access.decorate(found) });
  });
  routes.get("/customers/:customerId/messages", async (context) => {
    const access = await resolve(context);
    const page = await createCustomerRepository(context.env.DB).listMessages(
      customerId.parse(context.req.param("customerId")),
      withCursor(pageQuery.parse(messageQuery(context.req.url))), access.scope,
    );
    if (!page) throw new HTTPException(404, { message: "Customer not found" });
    return context.json({ ...pageBody(context.get("requestId"), page), items: page.items });
  });
  return routes;
}

function adminViewer(context: Context<AppBindings>) {
  return { type: "admin" as const, id: context.get("adminId") ?? "local" };
}

function errorBody(requestId: string, code: string, message: string) {
  return { requestId, error: { code, message } };
}

/**
 * Shared by the admin and device routes; `sender` is the device's employee and the customers they may write to, or
 * null for an administrator. `owner` decides which staged attachments the sender may use.
 */
async function sendMessage<B extends AppBindings>(
  context: Context<B>, customerKey: string, sender: { employeeId: string; scope: CustomerScope } | null, owner: AttachmentOwner, apiBase?: string,
) {
  const requestId = context.get("requestId");
  const employeeId = sender?.employeeId ?? null;
  const found = await createCustomerRepository(context.env.DB).getCustomer(customerId.parse(customerKey), sender?.scope);
  if (!found) throw new HTTPException(404, { message: "Customer not found" });
  const input = whatsappSendInput.parse(await context.req.json());
  const who = requestActor(context);
  const kind = "template" in input ? { type: "template", templateName: input.template.name }
    : "attachmentId" in input ? { type: "media" } : { type: "text" };
  const log = (action: "message_sent" | "message_failed", message?: { messageType: string }) => recordActivity(context, {
    ...who, category: "whatsapp", action, target: targetOf(found),
    details: { ...kind, ...(kind.type === "media" && message ? { mediaKind: message.messageType } : {}) },
  });
  try {
    const sent = await sendToCustomer(context.env as Env, found, input, employeeId, owner, apiBase, (outcome) => log(outcome.failed ? "message_failed" : "message_sent", outcome.message));
    return context.json({ requestId, message: sent }, 201);
  } catch (error) {
    if (error instanceof WhatsAppUnavailableError) {
      return context.json(errorBody(requestId, "WHATSAPP_NOT_CONFIGURED", "WhatsApp sending is not configured"), 503);
    }
    if (error instanceof WhatsAppWindowClosedError) {
      return context.json(errorBody(requestId, "window_closed", "The customer has not written in the last 24 hours; send an approved template"), 409);
    }
    if (error instanceof TemplateHeaderRequiredError) {
      return context.json(errorBody(requestId, "template_header_image_required", "This template needs a header file; choose one or set a default in Config"), 400);
    }
    if (error instanceof AttachmentNotFoundError) {
      return context.json(errorBody(requestId, "attachment_not_found", "The attachment was not found; upload it again"), 404);
    }
    if (error instanceof UnsupportedAttachmentError) {
      return context.json(errorBody(requestId, "unsupported_media_type", "WhatsApp cannot send this file in this place; images must be JPEG or PNG"), 400);
    }
    if (error instanceof WhatsAppSendFailedError) {
      return context.json(errorBody(requestId, "WHATSAPP_SEND_FAILED", "WhatsApp could not send the message"), 502);
    }
    throw error;
  }
}

const noStoreAdmin: MiddlewareHandler<AppBindings> = async (context, next) => {
  context.header("Cache-Control", "private, no-store");
  context.header("Pragma", "no-cache");
  context.header("Referrer-Policy", "no-referrer");
  context.header("X-Content-Type-Options", "nosniff");
  await next();
};

/** Mount at /v1/admin; callers must supply the existing administrator guard. */
export function createAdminCustomerRoutes(authorize: MiddlewareHandler<AppBindings>) {
  if (typeof authorize !== "function") throw new TypeError("Admin authorization is required");
  const routes = new Hono<AppBindings>();
  // Scoped to this module's paths: the router is mounted beside other /v1/admin modules.
  for (const path of ["/customers", "/customers/*", "/whatsapp/*"]) {
    // Registered first, so this also gates the other /whatsapp/* admin routers (config, media) mounted after it.
    routes.use(path, noStoreAdmin, authorize, requireFeature(path.startsWith("/whatsapp") ? "whatsapp" : "customers"));
  }
  routes.route("/", customerReadRoutes<AppBindings>(
    async () => ({ decorate: (item) => item }), (url) => adminListQuery.parse(queryValues(url)),
  ));
  routes.post("/customers/bulk", bodyLimit({
    maxSize: BULK_BODY_LIMIT, onError: () => { throw new ApiError(413, "request_too_large", "The request is too large; send fewer customers at a time"); },
  }), bulkCreateCustomers);
  routes.post("/customers", async (context) => {
    try {
      const created = await createCustomerRepository(context.env.DB).createCustomer(
        await context.req.json(),
      );
      await defer(context, notifyAssigned(context.env, created, created.employees.map((employee) => employee.id)));
      await recordActivity(context, {
        ...requestActor(context), category: "customer", action: "created", target: targetOf(created),
        details: { source: "admin", assigned: created.employees.length },
      });
      return context.json({ requestId: context.get("requestId"), customer: created }, 201);
    } catch (error) {
      if (error instanceof CustomerPhoneExistsError) {
        return context.json(errorBody(context.get("requestId"), "CUSTOMER_PHONE_EXISTS", "A customer with this phone number already exists"), 409);
      }
      if (error instanceof CustomerAssignmentError) {
        return context.json(errorBody(context.get("requestId"), "INVALID_REQUEST", "Employees must exist and be active"), 400);
      }
      throw error;
    }
  });
  routes.patch("/customers/:customerId", async (context) => {
    try {
      const repository = createCustomerRepository(context.env.DB);
      const id = customerId.parse(context.req.param("customerId"));
      const before = await repository.getCustomer(id);
      const updated = await repository.updateCustomer(id, await context.req.json());
      if (!updated || !before) throw new HTTPException(404, { message: "Customer not found" });
      const fields = changedFields(before, updated);
      if (fields.length > 0) {
        await recordActivity(context, {
          ...requestActor(context), category: "customer", action: "updated", target: targetOf(updated), details: { fields },
        });
      }
      return context.json({ requestId: context.get("requestId"), customer: updated });
    } catch (error) {
      if (error instanceof CustomerPhoneExistsError) {
        return context.json(errorBody(context.get("requestId"), "CUSTOMER_PHONE_EXISTS", "A customer with this phone number already exists"), 409);
      }
      throw error;
    }
  });
  routes.put("/customers/:customerId/employees", bodyLimit({ maxSize: 16384 }), async (context) => {
    try {
      const repository = createCustomerRepository(context.env.DB);
      const id = customerId.parse(context.req.param("customerId"));
      const previous = (await repository.getCustomer(id))?.employees ?? [];
      const before = new Set(previous.map((employee) => employee.id));
      const updated = await repository.setCustomerEmployees(id, customerEmployeesInput.parse(await context.req.json()).employeeIds);
      if (!updated) throw new HTTPException(404, { message: "Customer not found" });
      // Only people who were not handling this customer before are told; removal is silent.
      await defer(context, notifyAssigned(context.env, updated, updated.employees.map((employee) => employee.id).filter((employeeId) => !before.has(employeeId))));
      const now = new Set(updated.employees.map((employee) => employee.id));
      const added = updated.employees.filter((employee) => !before.has(employee.id)).map((employee) => employee.name);
      const removed = previous.filter((employee) => !now.has(employee.id)).map((employee) => employee.name);
      const who = requestActor(context);
      if (added.length > 0) await recordActivity(context, { ...who, category: "customer", action: "assigned", target: targetOf(updated), details: { employees: added } });
      if (removed.length > 0) await recordActivity(context, { ...who, category: "customer", action: "unassigned", target: targetOf(updated), details: { employees: removed } });
      return context.json({ requestId: context.get("requestId"), customer: updated });
    } catch (error) {
      if (error instanceof CustomerAssignmentError) {
        return context.json(errorBody(context.get("requestId"), "INVALID_REQUEST", "Employees must exist and be active"), 400);
      }
      throw error;
    }
  });
  routes.delete("/customers/:customerId", async (context) => {
    const id = customerId.parse(context.req.param("customerId"));
    const repository = createCustomerRepository(context.env.DB);
    const existing = await repository.getCustomer(id);
    if (!(await repository.archiveCustomer(id))) {
      throw new HTTPException(404, { message: "Customer not found" });
    }
    // Archiving an already archived customer changes nothing and logs nothing.
    if (existing) await recordActivity(context, { ...requestActor(context), category: "customer", action: "archived", target: targetOf(existing) });
    return context.json({ requestId: context.get("requestId"), customerId: id, status: "archived" });
  });
  routes.get("/customers/:customerId/calls", async (context) => {
    const page = await createCustomerRepository(context.env.DB).listCustomerCalls(
      customerId.parse(context.req.param("customerId")),
      withCursor(pageQuery.parse(queryValues(context.req.url))),
    );
    if (!page) throw new HTTPException(404, { message: "Customer not found" });
    return context.json({ ...pageBody(context.get("requestId"), page), items: page.items });
  });
  routes.post("/customers/:customerId/messages", (context) =>
    sendMessage(context, context.req.param("customerId"), null, { type: "admin", id: context.get("adminId") ?? "local" }));
  routes.get("/whatsapp/status", (context) =>
    context.json({ requestId: context.get("requestId"), canSend: whatsappCanSend(context.env) }));
  routes.get("/whatsapp/version", async (context) =>
    context.json({ requestId: context.get("requestId"), version: await createWhatsAppReadRepository(context.env.DB).feedVersion() }));
  routes.get("/whatsapp/unread", async (context) =>
    context.json({ requestId: context.get("requestId"), ...(await createWhatsAppReadRepository(context.env.DB).totals(adminViewer(context))) }));
  routes.post("/whatsapp/chats/:customerId/read", async (context) => {
    const id = customerId.parse(context.req.param("customerId"));
    if (!(await createCustomerRepository(context.env.DB).getCustomer(id))) throw new HTTPException(404, { message: "Customer not found" });
    await createWhatsAppReadRepository(context.env.DB).markRead(adminViewer(context), id);
    return context.json({ requestId: context.get("requestId"), customerId: id, unreadCount: 0 });
  });
  routes.get("/whatsapp/chats", async (context) => {
    const page = await createCustomerRepository(context.env.DB).listChats(
      withCursor(adminChatQuery.parse(queryValues(context.req.url))),
      undefined, adminViewer(context),
    );
    return context.json({ ...pageBody(context.get("requestId"), page), items: page.items });
  });
  return routes;
}

/** Resolves what the signed-in employee may read, narrowed by the optional `employeeId=<id|me|team>` filter (managers only). */
async function employeeReadAccess(context: Context<DeviceBindings>, apiBase: string): Promise<ReadAccess & { employee: EmployeeScope }> {
  const employee = await employeeScope(context);
  const filter = new URL(context.req.url).searchParams.get("employeeId") || undefined;
  return {
    employee,
    scope: { employeeIds: narrowEmployees(employee, filter), apiBase },
    decorate: (item) => withScopeLabel(employee, item),
  };
}

const withoutEmployeeFilter = (url: string) => takeQueryValue(queryValues(url), "employeeId").rest;

/**
 * Mount at /v1/device (or /v1/web). The credential identifies the employee, who sees only customers they handle (a
 * manager: also customers their active reports handle); anything else is a 404, never a 403.
 */
export function createDeviceCustomerRoutes(access: EmployeeAccess = deviceAccess) {
  const routes = new Hono<DeviceBindings>();
  // Path-scoped: this router shares /v1/device with unauthenticated registration.
  for (const path of ["/customers", "/customers/*", "/whatsapp/*"]) {
    routes.use(path, async (context, next) => {
      context.header("Cache-Control", "no-store");
      await next();
    }, access.authorize, requireFeature(path.startsWith("/whatsapp") ? "whatsapp" : "customers"));
  }
  // Registered before the generic `/customers/:customerId` read so `lookup` is not taken for an id.
  routes.get("/customers/lookup", async (context) => {
    const scope = await employeeScope(context);
    const result = await createCustomerRepository(context.env.DB).lookupByPhone(
      { phone: "", ...queryValues(context.req.url) }, { employeeIds: scope.employeeIds }, { handlers: isManager(scope) },
    );
    return context.json({ requestId: context.get("requestId"), ...result });
  });
  routes.post("/customers", async (context) => {
    const scope = await employeeScope(context);
    const employeeId = scope.selfId;
    const repository = createCustomerRepository(context.env.DB);
    const raw: unknown = await context.req.json();
    const fields = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : undefined;
    const requested = fields?.employeeId;
    if (fields) delete fields.employeeId;
    const body = fields ?? raw;
    // A manager may add a customer for a team member (or themselves, the default).
    let assignee = employeeId;
    if (requested !== undefined) {
      if (!isManager(scope)) throw notAManager();
      if (typeof requested !== "string" || !scope.employeeIds.includes(requested)) throw outOfScope();
      assignee = requested;
    }
    const { phone } = deviceCustomerCreateInput.parse(body);
    // Another employee's customer is reported as a bare conflict; only one in the caller's scope is identified.
    const conflict = async () => {
      const found = await repository.lookupByPhone({ phone: phone.phone }, { employeeIds: scope.employeeIds });
      if (!found.exists) return null;
      const requestId = context.get("requestId");
      const existingId = found.customer?.id;
      return context.json({
        requestId,
        error: { code: "customer_exists", message: "A customer with this phone number already exists", ...(existingId ? { customerId: existingId } : {}) },
        ...(existingId ? { customerId: existingId } : {}),
      }, 409);
    };
    const existing = await conflict();
    if (existing) return existing;
    try {
      const created = await repository.createOwnCustomer(employeeId, body as z.input<typeof deviceCustomerCreateInput>, assignee);
      if (assignee !== employeeId) await defer(context, notifyAssigned(context.env, created, [assignee]));
      await recordActivity(context, {
        ...requestActor(context), category: "customer", action: "created", target: targetOf(created),
        details: { source: access.apiBase === "/v1/web" ? "employee_web" : "employee_app", assigned: 1 },
      });
      return context.json({ requestId: context.get("requestId"), customer: withScopeLabel(scope, created) }, 201);
    } catch (error) {
      // Lost a race with another creator of the same number.
      if (error instanceof CustomerPhoneExistsError) {
        const raced = await conflict();
        if (raced) return raced;
      }
      if (error instanceof CustomerAssignmentError) throw outOfScope();
      throw error;
    }
  });
  routes.patch("/customers/:customerId", async (context) => {
    const employee = await employeeScope(context);
    const scope = { employeeIds: employee.employeeIds };
    const repository = createCustomerRepository(context.env.DB);
    const id = customerId.parse(context.req.param("customerId"));
    const current = await repository.getCustomer(id, scope);
    if (!current) throw new HTTPException(404, { message: "Customer not found" });
    const { phone, ...changes } = deviceCustomerUpdateInput.parse(await context.req.json());
    // The phone number identifies the customer; sending the stored number back is allowed, anything else is not.
    if (phone !== undefined && normalizePhone(phone)?.phone !== current.phone) {
      throw new ApiError(400, "phone_not_editable", "The phone number of a customer cannot be changed");
    }
    if (changes.name === undefined && changes.notes === undefined) {
      return context.json({ requestId: context.get("requestId"), customer: withScopeLabel(employee, current) });
    }
    const updated = await repository.updateCustomer(id, changes, scope);
    if (!updated) throw new HTTPException(404, { message: "Customer not found" });
    const fields = changedFields(current, updated);
    if (fields.length > 0) {
      await recordActivity(context, { ...requestActor(context), category: "customer", action: "updated", target: targetOf(updated), details: { fields } });
    }
    return context.json({ requestId: context.get("requestId"), customer: withScopeLabel(employee, updated) });
  });
  // A manager hands customers over inside their team: the handler set within the scope becomes `employeeIds`;
  // handlers outside the scope are preserved.
  routes.put("/customers/:customerId/handlers", bodyLimit({ maxSize: 16384 }), async (context) => {
    const manager = await requireManagerScope(context);
    const repository = createCustomerRepository(context.env.DB);
    const id = customerId.parse(context.req.param("customerId"));
    const current = await repository.getCustomer(id, { employeeIds: manager.employeeIds });
    if (!current) throw new HTTPException(404, { message: "Customer not found" });
    const wanted = [...new Set(customerEmployeesInput.parse(await context.req.json()).employeeIds)];
    if (wanted.some((employeeId) => !manager.employeeIds.includes(employeeId))) throw outOfScope();
    const outside = current.employees.filter((employee) => !manager.employeeIds.includes(employee.id));
    if (wanted.length + outside.length === 0) {
      throw new ApiError(409, "handler_required", "A customer needs at least one handler");
    }
    let updated: Customer | null;
    try {
      updated = await repository.setScopedHandlers(id, manager.employeeIds, wanted);
    } catch (error) {
      if (error instanceof CustomerAssignmentError) throw outOfScope();
      throw error;
    }
    if (!updated) throw new HTTPException(404, { message: "Customer not found" });
    const before = new Set(current.employees.map((employee) => employee.id));
    const now = new Set(updated.employees.map((employee) => employee.id));
    const added = updated.employees.filter((employee) => !before.has(employee.id));
    const removed = current.employees.filter((employee) => !now.has(employee.id));
    // Only newly assigned colleagues are told, never the manager who did it.
    await defer(context, notifyAssigned(context.env, updated, added.map((employee) => employee.id).filter((employeeId) => employeeId !== manager.selfId)));
    if (added.length > 0 || removed.length > 0) {
      await recordActivity(context, {
        ...requestActor(context), category: "customer", action: "customers_handed_over", target: targetOf(updated),
        details: { added: added.length, removed: removed.length, to: added.map((employee) => employee.name), from: removed.map((employee) => employee.name) },
      });
    }
    return context.json({ requestId: context.get("requestId"), customer: withScopeLabel(manager, updated) });
  });
  routes.route("/", customerReadRoutes<DeviceBindings>(
    (context) => employeeReadAccess(context, access.apiBase),
    (url) => deviceListQuery.parse(withoutEmployeeFilter(url)),
    withoutEmployeeFilter,
  ));
  routes.get("/whatsapp/chats", async (context) => {
    const read = await employeeReadAccess(context, access.apiBase);
    const page = await createCustomerRepository(context.env.DB).listChats(
      withCursor(deviceListQuery.parse(withoutEmployeeFilter(context.req.url))),
      read.scope, { type: "employee", id: read.employee.selfId },
    );
    return context.json({ ...pageBody(context.get("requestId"), page), items: page.items.map((chat) => read.decorate(chat)) });
  });
  routes.get("/whatsapp/status", (context) =>
    context.json({ requestId: context.get("requestId"), canSend: whatsappCanSend(context.env) }));
  routes.get("/whatsapp/version", async (context) =>
    context.json({ requestId: context.get("requestId"), version: await createWhatsAppReadRepository(context.env.DB).feedVersion() }));
  routes.get("/whatsapp/unread", async (context) => {
    const read = await employeeReadAccess(context, access.apiBase);
    return context.json({ requestId: context.get("requestId"),
      ...(await createWhatsAppReadRepository(context.env.DB).totals({ type: "employee", id: read.employee.selfId }, read.scope?.employeeIds)) });
  });
  routes.post("/whatsapp/chats/:customerId/read", async (context) => {
    const scope = await employeeScope(context);
    const id = customerId.parse(context.req.param("customerId"));
    if (!(await createCustomerRepository(context.env.DB).getCustomer(id, { employeeIds: scope.employeeIds }))) throw new HTTPException(404, { message: "Customer not found" });
    await createWhatsAppReadRepository(context.env.DB).markRead({ type: "employee", id: scope.selfId }, id);
    return context.json({ requestId: context.get("requestId"), customerId: id, unreadCount: 0 });
  });
  routes.post("/customers/:customerId/messages", async (context) => {
    const scope = await employeeScope(context);
    return sendMessage(context, context.req.param("customerId"), { employeeId: scope.selfId, scope: { employeeIds: scope.employeeIds, apiBase: access.apiBase } },
      { type: "device", id: context.get("device").id }, access.apiBase);
  });
  return routes;
}
