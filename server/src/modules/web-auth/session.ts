import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

import type { Device } from "../../data/identity";
import { createWebAuthRepository, WEB_SESSION_ABSOLUTE_MS, type WebAuthRepository, type WebSession } from "../../data/web-auth";
import type { AppBindings } from "../../app";
import type { Env } from "../../env";
import { ApiError } from "../../http/errors";
import { constantTimeEqual, webCrypto, type WebCrypto } from "../../security/web-crypto";
import { employeeWebActive, readEmployeeWeb, type EmployeeWebSettings } from "../../settings/employee-web";
import { loadSettings } from "../../settings/service";
import type { DeviceBindings, EmployeeAccess } from "../identity";

export const SESSION_COOKIE = "__Host-lk_session";
export const CSRF_HEADER = "X-Linekeep-CSRF";

export type WebBindings = DeviceBindings & {
  Variables: DeviceBindings["Variables"] & { webSession: WebSession; webToken: string };
};

export function webAuthRepository(env: Env): WebAuthRepository {
  return createWebAuthRepository(env.DB, env.TOKEN_HASH_SECRET);
}

export function webKeys(env: Env): WebCrypto {
  return webCrypto(env.TOKEN_HASH_SECRET);
}

/** The cookie that carries the session: no Domain (host-only), Path=/, HttpOnly, Secure, SameSite=Strict. */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${WEB_SESSION_ABSOLUTE_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export const clearedSessionCookie = `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;

export function webDisabled(): ApiError {
  return new ApiError(404, "web_disabled", "Employee web access is turned off");
}

/** The stored web settings from the per-isolate settings cache. */
export async function webSettings(env: Env): Promise<EmployeeWebSettings> {
  return readEmployeeWeb((await loadSettings(env)).values);
}

/**
 * 404 `web_disabled` unless an administrator has switched the employee web app on AND at least one sign-in method
 * can deliver a code (the switch alone is not enough).
 */
export const requireWebEnabled: MiddlewareHandler<AppBindings> = async (context, next) => {
  if (!employeeWebActive(context.env, await webSettings(context.env))) throw webDisabled();
  await next();
};

const mutating = (method: string) => method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

/**
 * A browser states where a request comes from. A mutation that says it came from another origin or site is
 * refused; requests that say nothing (scripts, tests) are left to the CSRF token.
 */
export const refuseCrossSite: MiddlewareHandler<AppBindings> = async (context, next) => {
  if (mutating(context.req.method)) {
    const origin = context.req.header("Origin");
    const site = context.req.header("Sec-Fetch-Site");
    if ((origin !== undefined && origin !== new URL(context.req.url).origin)
      || (site !== undefined && site !== "same-origin" && site !== "none")) {
      throw new ApiError(403, "csrf_invalid", "This request did not come from the Linekeep web app");
    }
  }
  await next();
};

/**
 * Signs the request in as the employee behind the session cookie. Mutations also need the CSRF token, which is
 * derived from the cookie value and handed to the page when it signs in.
 */
export const requireWebEmployee: MiddlewareHandler<WebBindings> = async (context, next) => {
  if (!employeeWebActive(context.env, await webSettings(context.env))) throw webDisabled();
  const token = getCookie(context, SESSION_COOKIE);
  const session = token ? await webAuthRepository(context.env).authenticate(token) : null;
  if (!token || !session) throw new ApiError(401, "unauthorized", "Sign in again to continue");
  if (mutating(context.req.method)) {
    const sent = context.req.header(CSRF_HEADER);
    const expected = await webKeys(context.env).mac("csrf", token);
    if (sent === undefined || !constantTimeEqual(sent, expected)) {
      throw new ApiError(403, "csrf_invalid", "The request was refused; reload the page and try again");
    }
  }
  context.set("webSession", session);
  context.set("webToken", token);
  // The employee routers shared with the phone app read the signed-in employee from `device`.
  const at = new Date().toISOString();
  const device: Device = {
    id: `web_${session.employee.id}`, employeeId: session.employee.id, phoneNumbers: [], assignedAt: at, createdAt: at,
  };
  context.set("device", device);
  await next();
};

/**
 * Hands the shared employee routers the web session: `requireWebEmployee` has already run for the whole mount, so
 * this only confirms it did. Media URLs they return point at /v1/web.
 */
export const webAccess: EmployeeAccess = {
  apiBase: "/v1/web",
  authorize: async (context, next) => {
    if (!context.get("device")) throw new ApiError(401, "unauthorized", "Sign in again to continue");
    await next();
  },
};
