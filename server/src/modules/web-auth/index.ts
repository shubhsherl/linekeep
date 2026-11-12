import { Hono, type Context } from "hono";
import { z } from "zod";

import { normalizeEmail } from "../../data/identity";
import { isLocalDevelopment } from "../../http/admin-auth";
import {
  LOGIN_REQUESTS_PER_EMAIL_PER_HOUR, LOGIN_REQUESTS_PER_IP_PER_HOUR,
} from "../../data/web-auth";
import { ApiError } from "../../http/errors";
import { defer } from "../../http/defer";
import { constantTimeEqual } from "../../security/web-crypto";
import { readEmployeeWeb, usableMethods, type EmployeeWebSettings } from "../../settings/employee-web";
import { loadSettings } from "../../settings/service";
import { createDeviceEmployeeRoutes } from "../device-employee";
import { createDeviceWhatsAppConfigRoutes } from "../whatsapp/config-routes";
import { createDeviceCustomerRoutes } from "../customers";
import { createDeviceWhatsAppMediaRoutes } from "../whatsapp/media";
import { createDeviceWhatsAppOutboundRoutes } from "../whatsapp/outbound-routes";
import { createWebCallRoutes } from "./calls";
import { deliverEmailCode, deliverWhatsAppCode } from "./delivery";
import {
  clearedSessionCookie, refuseCrossSite, requireWebEmployee, requireWebEnabled, sessionCookie, SESSION_COOKIE,
  webAccess, webAuthRepository, webKeys, type WebBindings,
} from "./session";
import { getCookie } from "hono/cookie";

const requestInput = z.strictObject({ email: z.string().max(320), method: z.enum(["email", "whatsapp"]) });
const verifyInput = z.strictObject({ email: z.string().max(320), code: z.string().max(64) });

const invalidCode = () => new ApiError(401, "invalid_code", "That code is not valid. Request a new one and try again.");

function rateLimited(verdict: { retryAfterSeconds: number }): ApiError {
  return new ApiError(429, "rate_limited", "Too many sign-in attempts; wait a while and try again", {
    "Retry-After": String(verdict.retryAfterSeconds),
  });
}

async function webSettings(context: Context<WebBindings>): Promise<EmployeeWebSettings> {
  return readEmployeeWeb((await loadSettings(context.env)).values);
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
    const settings = await webSettings(context);
    return context.json({
      requestId: context.get("requestId"),
      enabled: settings.enabled,
      methods: settings.enabled ? usableMethods(context.env, settings) : [],
    });
  });

  web.post("/auth/request", requireWebEnabled, async (context) => {
    const input = requestInput.parse(await context.req.json());
    const email = normalizeEmail(input.email);
    if (!email) throw new ApiError(400, "INVALID_REQUEST", "Enter a valid email address");
    const settings = await webSettings(context);
    if (!usableMethods(context.env, settings).includes(input.method)) {
      throw new ApiError(400, "method_unavailable", "That sign-in method is not available");
    }
    const keys = webKeys(context.env);
    const repository = webAuthRepository(context.env);

    // Equal work whether or not the address belongs to an employee: the counters move, a code row is written
    // (a decoy that can never be redeemed for an unknown address), and only the delivery differs, after the response.
    const emailKey = await keys.mac("email", email);
    const ipVerdict = await repository.hit(
      `ip:${await keys.mac("ip", context.req.header("CF-Connecting-IP") ?? "unknown")}`, LOGIN_REQUESTS_PER_IP_PER_HOUR,
    );
    if (!ipVerdict.allowed) throw rateLimited(ipVerdict);
    const wait = await repository.cooldownSeconds(`email:${emailKey}`);
    if (wait > 0) throw rateLimited({ retryAfterSeconds: wait });
    const emailVerdict = await repository.hit(`email:${emailKey}`, LOGIN_REQUESTS_PER_EMAIL_PER_HOUR);
    if (!emailVerdict.allowed) throw rateLimited(emailVerdict);

    const employee = await repository.findEmployeeByEmail(email);
    const code = keys.code();
    const id = `wlc_${crypto.randomUUID()}`;
    await repository.storeCode({
      id, emailKey, employeeId: employee?.id ?? null, method: input.method, codeHash: await keys.mac("otp", `${id}:${code}`),
    });
    if (employee) {
      // Local development only (localhost and ENVIRONMENT=development and WEB_OTP_DEV_LOG=true): lets a developer
      // sign in without a mail or WhatsApp account. It is never active on a deployed Worker.
      if (context.env.WEB_OTP_DEV_LOG === "true" && isLocalDevelopment(context.env, new URL(context.req.url))) {
        console.log(JSON.stringify({ event: "web_sign_in_code_dev", method: input.method, code }));
      }
      await defer(context, input.method === "email"
        ? deliverEmailCode(context.env, email, code)
        : deliverWhatsAppCode(context.env, employee, settings, code));
    }
    if (Math.random() < 0.05) await defer(context, repository.purge());
    return context.json({ requestId: context.get("requestId"), sent: true }, 202);
  });

  web.post("/auth/verify", requireWebEnabled, async (context) => {
    const input = verifyInput.parse(await context.req.json());
    const email = normalizeEmail(input.email);
    const keys = webKeys(context.env);
    const repository = webAuthRepository(context.env);
    if (!email || !/^\d{6}$/.test(input.code)) throw invalidCode();

    // An attempt is spent before the comparison, so concurrent guesses cannot beat the limit of five.
    const attempt = await repository.takeAttempt(await keys.mac("email", email));
    const given = await keys.mac("otp", `${attempt?.id ?? "wlc_none"}:${input.code}`);
    const matches = constantTimeEqual(given, attempt?.codeHash ?? await keys.mac("otp", "wlc_none:decoy"));
    if (!attempt || !attempt.employeeId || !matches) throw invalidCode();
    if (!(await repository.redeemCode(attempt.id))) throw invalidCode();
    const employee = await repository.findEmployeeByEmail(email);
    if (!employee || employee.id !== attempt.employeeId) throw invalidCode();

    const session = await repository.createSession(employee.id);
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
