import { Hono, type Context } from "hono";
import { z } from "zod";

import { recordActivity, requestSecurity } from "../../activity/record";
import { normalizePhone } from "../../data/customers";
import { normalizeEmail } from "../../data/identity";
import { isLocalDevelopment } from "../../http/admin-auth";
import {
  LOGIN_REQUESTS_PER_IDENTIFIER_PER_HOUR, LOGIN_REQUESTS_PER_IP_PER_HOUR, type SignInIdentifier,
} from "../../data/web-auth";
import { ApiError } from "../../http/errors";
import { defer } from "../../http/defer";
import { constantTimeEqual, type WebCrypto } from "../../security/web-crypto";
import { employeeWebActive, usableMethods } from "../../settings/employee-web";
import { createDeviceEmployeeRoutes } from "../device-employee";
import { createDeviceWhatsAppConfigRoutes } from "../whatsapp/config-routes";
import { createDeviceCustomerRoutes } from "../customers";
import { createDeviceWhatsAppMediaRoutes } from "../whatsapp/media";
import { createDeviceWhatsAppOutboundRoutes } from "../whatsapp/outbound-routes";
import { createWebCallRoutes } from "./calls";
import { deliverEmailCode, deliverWhatsAppCode } from "./delivery";
import {
  clearedSessionCookie, refuseCrossSite, requireWebEmployee, requireWebEnabled, sessionCookie, SESSION_COOKIE,
  webAccess, webAuthRepository, webKeys, webSettings, type WebBindings,
} from "./session";
import { getCookie } from "hono/cookie";

const requestInput = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("email"), email: z.string().max(320) }),
  z.strictObject({ method: z.literal("whatsapp"), phone: z.string().max(64) }),
]);
const verifyInput = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("email"), email: z.string().max(320), code: z.string().max(64) }),
  z.strictObject({ method: z.literal("whatsapp"), phone: z.string().max(64), code: z.string().max(64) }),
]);

interface ResolvedIdentifier {
  identifier: SignInIdentifier;
  /** Keyed hash of the identifier under its method's key: ties a code to the method and identifier it was issued for. */
  key: string;
  /** The normalised address, for the mail itself. */
  email?: string;
}

/** Normalises what was typed (email, or any common way of writing a phone number); null when it is not well formed. */
async function resolveIdentifier(keys: WebCrypto, input: { method: "email"; email: string } | { method: "whatsapp"; phone: string }): Promise<ResolvedIdentifier | null> {
  if (input.method === "email") {
    const email = normalizeEmail(input.email);
    return email ? { identifier: { method: "email", email }, key: await keys.mac("email", email), email } : null;
  }
  const phone = normalizePhone(input.phone);
  return phone ? { identifier: { method: "whatsapp", phoneKey: phone.phoneKey }, key: await keys.mac("phone", phone.phoneKey) } : null;
}

const invalidCode = () => new ApiError(401, "invalid_code", "That code is not valid. Request a new one and try again.");

function rateLimited(verdict: { retryAfterSeconds: number }): ApiError {
  return new ApiError(429, "rate_limited", "Too many sign-in attempts; wait a while and try again", {
    "Retry-After": String(verdict.retryAfterSeconds),
  });
}


/** The body of a successful sign-in and of `GET /session`. */
async function sessionBody(context: Context<WebBindings>) {
  const { employee, expiresAt } = context.get("webSession");
  return {
    requestId: context.get("requestId"),
    employee: { id: employee.id, name: employee.name, phoneNumber: employee.phoneNumber },
    csrfToken: await webKeys(context.env).mac("csrf", context.get("webToken")),
    expiresAt,
  };
}

/**
 * Mount at /v1/web. Public and Access-free: sign-in by emailed (or WhatsApp) one-time code, then the employee's own
 * data through the same routers the phone app uses, bound to the signed-in employee by the session cookie.
 */
export function createWebRoutes() {
  const web = new Hono<WebBindings>();

  web.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
    // Media files may be revalidated but never reused without the cookie.
    if (context.res.headers.get("Cache-Control")?.includes("max-age")) {
      context.res.headers.set("Cache-Control", "private, no-cache");
    }
  });
  web.use("*", refuseCrossSite);

  web.get("/config", async (context) => {
    const settings = await webSettings(context.env);
    const active = employeeWebActive(context.env, settings);
    return context.json({
      requestId: context.get("requestId"),
      enabled: active,
      methods: active ? usableMethods(context.env, settings) : [],
    });
  });

  web.post("/auth/request", requireWebEnabled, async (context) => {
    const input = requestInput.parse(await context.req.json());
    const keys = webKeys(context.env);
    const resolved = await resolveIdentifier(keys, input);
    if (!resolved) throw new ApiError(400, "INVALID_REQUEST", input.method === "email" ? "Enter a valid email address" : "Enter a valid phone number");
    const settings = await webSettings(context.env);
    if (!usableMethods(context.env, settings).includes(input.method)) {
      throw new ApiError(400, "method_unavailable", "That sign-in method is not available");
    }
    const repository = webAuthRepository(context.env);

    // Equal work whatever the identifier turns out to be (unknown, no phone, shared by two employees, not on
    // WhatsApp, a real employee): the counters move, a code row is written (a decoy that can never be redeemed
    // unless exactly one active employee matches), and only the delivery differs, after the response.
    const counter = `${input.method}:${resolved.key}`;
    const ipVerdict = await repository.hit(
      `ip:${await keys.mac("ip", context.req.header("CF-Connecting-IP") ?? "unknown")}`, LOGIN_REQUESTS_PER_IP_PER_HOUR,
    );
    if (!ipVerdict.allowed) throw rateLimited(ipVerdict);
    // Only a request for a real employee is logged; the lookup happens for every refused identifier, so it tells nothing.
    const refuse = async (limit: "cooldown" | "hourly", verdict: { retryAfterSeconds: number }): Promise<never> => {
      const known = await repository.findEmployee(resolved.identifier);
      if (known) {
        await recordActivity(context, {
          actor: { type: "employee", id: known.id, name: known.name }, channel: "web", category: "signin", action: "rate_limited",
          details: { method: input.method, limit }, security: requestSecurity(context),
        });
      }
      throw rateLimited(verdict);
    };
    const wait = await repository.cooldownSeconds(counter);
    if (wait > 0) return refuse("cooldown", { retryAfterSeconds: wait });
    const verdict = await repository.hit(counter, LOGIN_REQUESTS_PER_IDENTIFIER_PER_HOUR);
    if (!verdict.allowed) return refuse("hourly", verdict);

    const employee = await repository.findEmployee(resolved.identifier);
    const code = keys.code();
    const id = `wlc_${crypto.randomUUID()}`;
    await repository.storeCode({
      id, identifierKey: resolved.key, employeeId: employee?.id ?? null, method: input.method,
      codeHash: await keys.mac("otp", `${id}:${code}`),
    });
    if (employee) {
      await recordActivity(context, {
        actor: { type: "employee", id: employee.id, name: employee.name }, channel: "web", category: "signin", action: "code_requested",
        details: { method: input.method }, security: requestSecurity(context),
      });
      // Local development only (localhost and ENVIRONMENT=development and WEB_OTP_DEV_LOG=true): lets a developer
      // sign in without a mail or WhatsApp account. It is never active on a deployed Worker.
      if (context.env.WEB_OTP_DEV_LOG === "true" && isLocalDevelopment(context.env, new URL(context.req.url))) {
        console.log(JSON.stringify({ event: "web_sign_in_code_dev", method: input.method, code }));
      }
      // The code goes only to what the admin stored on the employee, never to what the caller typed.
      await defer(context, input.method === "email"
        ? deliverEmailCode(context.env, resolved.email ?? "", code)
        : deliverWhatsAppCode(context.env, employee, settings, code));
    }
    if (Math.random() < 0.05) await defer(context, repository.purge());
    return context.json({ requestId: context.get("requestId"), sent: true }, 202);
  });

  web.post("/auth/verify", requireWebEnabled, async (context) => {
    const input = verifyInput.parse(await context.req.json());
    const keys = webKeys(context.env);
    const repository = webAuthRepository(context.env);
    const resolved = await resolveIdentifier(keys, input);
    if (!resolved || !/^\d{6}$/.test(input.code)) throw invalidCode();

    // An attempt is spent before the comparison, so concurrent guesses cannot beat the limit of five. The code
    // is found by method and identifier, so one issued for another method or identifier never matches.
    const attempt = await repository.takeAttempt(resolved.key, input.method);
    const given = await keys.mac("otp", `${attempt?.id ?? "wlc_none"}:${input.code}`);
    const matches = constantTimeEqual(given, attempt?.codeHash ?? await keys.mac("otp", "wlc_none:decoy"));
    if (attempt?.employeeId && !matches) {
      // A wrong guess at a code issued to a real employee. The code that was typed is never recorded.
      await recordActivity(context, {
        actor: { type: "employee", id: attempt.employeeId }, channel: "web", category: "signin", action: "sign_in_failed",
        details: { method: input.method, reason: "wrong_code" }, security: requestSecurity(context),
      });
    }
    if (!attempt || !attempt.employeeId || !matches) throw invalidCode();
    if (!(await repository.redeemCode(attempt.id))) throw invalidCode();
    const employee = await repository.findEmployee(resolved.identifier);
    if (!employee || employee.id !== attempt.employeeId) throw invalidCode();

    const session = await repository.createSession(employee.id);
    await recordActivity(context, {
      actor: { type: "employee", id: employee.id, name: employee.name }, channel: "web", category: "signin", action: "signed_in",
      details: { method: input.method }, security: requestSecurity(context),
    });
    context.header("Set-Cookie", sessionCookie(session.token));
    context.set("webSession", { id: "", employee, expiresAt: session.expiresAt });
    context.set("webToken", session.token);
    return context.json(await sessionBody(context));
  });

  web.get("/session", requireWebEmployee, async (context) => context.json(await sessionBody(context)));

  web.post("/auth/logout", requireWebEnabled, async (context) => {
    const token = getCookie(context, SESSION_COOKIE);
    if (token) {
      // With a live session the request must prove it is the page's own; a stale cookie can just be dropped.
      const session = await webAuthRepository(context.env).authenticate(token);
      if (session) {
        const sent = context.req.header("X-Linekeep-CSRF");
        if (sent === undefined || !constantTimeEqual(sent, await webKeys(context.env).mac("csrf", token))) {
          throw new ApiError(403, "csrf_invalid", "The request was refused; reload the page and try again");
        }
      }
      await webAuthRepository(context.env).endSession(token);
      if (session) {
        await recordActivity(context, {
          actor: { type: "employee", id: session.employee.id, name: session.employee.name }, channel: "web", category: "signin",
          action: "signed_out", security: requestSecurity(context),
        });
      }
    }
    context.header("Set-Cookie", clearedSessionCookie);
    return context.json({ requestId: context.get("requestId"), signedOut: true });
  });

  // Everything below needs a signed-in employee and, for changes, the CSRF header.
  web.use("*", requireWebEmployee);
  web.route("/", createDeviceEmployeeRoutes(undefined, webAccess));
  web.route("/", createDeviceCustomerRoutes(webAccess));
  web.route("/", createDeviceWhatsAppConfigRoutes(webAccess));
  web.route("/", createDeviceWhatsAppMediaRoutes(webAccess));
  web.route("/", createDeviceWhatsAppOutboundRoutes(webAccess));
  web.route("/", createWebCallRoutes());
  return web;
}
