import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { AppBindings } from "../../app";
import { callHistoryCursor } from "../../data/call-history";
import {
  CustomerAssignmentError,
  CustomerPhoneExistsError,
  createCustomerRepository,
  customerEmployeesInput,
  whatsappSendInput,
  type CustomerCursor,
} from "../../data/customers";
import { requireDevice, type DeviceBindings } from "../identity";

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

/** The shared handlers only differ in who may see which customer. */
function customerReadRoutes<B extends AppBindings>(
  resolveScope: (context: Context<B>) => { employeeId: string } | undefined,
  parseList: (url: string) => ListQuery,
) {
  const routes = new Hono<B>();
  routes.get("/customers", async (context) => {
    const page = await createCustomerRepository(context.env.DB).listCustomers(
      withCursor(parseList(context.req.url)), resolveScope(context),
    );
    return context.json({ ...pageBody(context.get("requestId"), page), items: page.items });
  });
  routes.get("/customers/:customerId", async (context) => {
    const found = await createCustomerRepository(context.env.DB).getCustomer(
      customerId.parse(context.req.param("customerId")), resolveScope(context),
    );
    if (!found) throw new HTTPException(404, { message: "Customer not found" });
    return context.json({ requestId: context.get("requestId"), customer: found });
  });
  routes.get("/customers/:customerId/messages", async (context) => {
    const page = await createCustomerRepository(context.env.DB).listMessages(
      customerId.parse(context.req.param("customerId")),
      withCursor(pageQuery.parse(queryValues(context.req.url))), resolveScope(context),
    );
    if (!page) throw new HTTPException(404, { message: "Customer not found" });
    return context.json({ ...pageBody(context.get("requestId"), page), items: page.items });
  });
  return routes;
}

function errorBody(requestId: string, code: string, message: string) {
  return { requestId, error: { code, message } };
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
    routes.use(path, noStoreAdmin, authorize);
  }
  routes.route("/", customerReadRoutes<AppBindings>(
    () => undefined, (url) => adminListQuery.parse(queryValues(url)),
  ));
  routes.post("/customers", async (context) => {
    try {
      const created = await createCustomerRepository(context.env.DB).createCustomer(
        await context.req.json(),
      );
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
      const updated = await createCustomerRepository(context.env.DB).updateCustomer(
        customerId.parse(context.req.param("customerId")),
        await context.req.json(),
      );
      if (!updated) throw new HTTPException(404, { message: "Customer not found" });
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
      const updated = await createCustomerRepository(context.env.DB).setCustomerEmployees(
        customerId.parse(context.req.param("customerId")),
        customerEmployeesInput.parse(await context.req.json()).employeeIds,
      );
      if (!updated) throw new HTTPException(404, { message: "Customer not found" });
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
    if (!(await createCustomerRepository(context.env.DB).archiveCustomer(id))) {
      throw new HTTPException(404, { message: "Customer not found" });
    }
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
  routes.get("/whatsapp/chats", async (context) => {
    const page = await createCustomerRepository(context.env.DB).listChats(
      withCursor(adminChatQuery.parse(queryValues(context.req.url))),
    );
    return context.json({ ...pageBody(context.get("requestId"), page), items: page.items });
  });
  return routes;
}

/**
 * Mount at /v1/device. The bearer credential identifies the device's current employee, who
 * sees only assigned customers; anything else is a 404, never a 403.
 */
export function createDeviceCustomerRoutes() {
  const routes = new Hono<DeviceBindings>();
  // Path-scoped: this router shares /v1/device with unauthenticated registration.
  for (const path of ["/customers", "/customers/*", "/whatsapp/*"]) {
    routes.use(path, async (context, next) => {
      context.header("Cache-Control", "no-store");
      await next();
    }, requireDevice);
  }
  routes.route("/", customerReadRoutes<DeviceBindings>(
    (context) => ({ employeeId: context.get("device").employeeId }),
    (url) => deviceListQuery.parse(queryValues(url)),
  ));
  routes.get("/whatsapp/chats", async (context) => {
    const page = await createCustomerRepository(context.env.DB).listChats(
      withCursor(deviceListQuery.parse(queryValues(context.req.url))),
      { employeeId: context.get("device").employeeId },
    );
    return context.json({ ...pageBody(context.get("requestId"), page), items: page.items });
  });
  routes.get("/whatsapp/status", (context) =>
    // No WhatsApp transport exists yet; clients must show a disabled composer.
    context.json({ requestId: context.get("requestId"), canSend: false }));
  routes.post("/customers/:customerId/messages", async (context) => {
    const found = await createCustomerRepository(context.env.DB).getCustomer(
      customerId.parse(context.req.param("customerId")),
      { employeeId: context.get("device").employeeId },
    );
    if (!found) throw new HTTPException(404, { message: "Customer not found" });
    whatsappSendInput.parse(await context.req.json());
    return context.json(errorBody(context.get("requestId"), "WHATSAPP_NOT_CONFIGURED", "WhatsApp sending is not configured"), 503);
  });
  return routes;
}
