import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { verifyWithJwks } from "hono/jwt";
import { timingSafeEqual } from "hono/utils/buffer";

import { linekeepMark } from "../admin-ui/brand";
import type { AppBindings } from "../app";
import type { Env } from "../env";

const localHosts: Record<string, true> = {
  localhost: true,
  "127.0.0.1": true,
  "[::1]": true,
};
const localCookie = "calltracker_local_admin";
const sessionLifetimeMs = 60 * 60 * 1000;

export function isLocalDevelopment(env: Env, url: URL) {
  return env.ENVIRONMENT === "development" && localHosts[url.hostname] === true;
}

function localSecret(env: Env) {
  const secret = env.LOCAL_ADMIN_SECRET;
  if (!secret || new TextEncoder().encode(secret).byteLength < 32) {
    throw new HTTPException(500, {
      message: "Local administrator access is not configured",
    });
  }
  return secret;
}

export const requireAdmin: MiddlewareHandler<AppBindings> = async (
  context,
  next,
) => {
  if (context.get("adminAuthorized")) {
    await next();
    return;
  }
  const url = new URL(context.req.url);
  const origin = context.req.header("Origin");
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(context.req.method);
  if (mutating && origin && origin !== url.origin) {
    throw new HTTPException(401, {
      message: "Administrator authentication required",
    });
  }

  if (isLocalDevelopment(context.env, url)) {
    const secret = localSecret(context.env);
    const authorization = context.req.header("Authorization");
    let authenticated = false;
    if (authorization) {
      const bearer = authorization.match(/^Bearer ([^\s]+)$/i);
      authenticated =
        !!bearer &&
        bearer[1].length <= 512 &&
        (await timingSafeEqual(bearer[1], secret));
    } else {
      const cookie = await getSignedCookie(
        context,
        `calltracker:local-admin-session:${secret}`,
        localCookie,
      );
      const expiry = cookie && /^\d+$/.test(cookie) ? Number(cookie) : 0;
      const now = Date.now();
      authenticated =
        Number.isSafeInteger(expiry) &&
        expiry > now &&
        expiry <= now + sessionLifetimeMs;
      if (authenticated && mutating && origin !== url.origin)
        authenticated = false;
    }
    if (!authenticated)
      throw new HTTPException(401, {
        message: "Administrator authentication required",
      });
  } else {
    const token = context.req.header("Cf-Access-Jwt-Assertion");
    if (!token || token.length > 16384)
      throw new HTTPException(401, {
        message: "Administrator authentication required",
      });
    const issuer = context.env.ACCESS_TEAM_DOMAIN;
    const audience = context.env.ACCESS_AUDIENCE;
    if (
      !issuer ||
      !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(
        issuer,
      ) ||
      !audience?.trim()
    ) {
      throw new HTTPException(500, {
        message: "Administrator access is not configured",
      });
    }
    try {
      const identity = await verifyWithJwks(
        token,
        {
          jwks_uri: `${issuer}/cdn-cgi/access/certs`,
          allowedAlgorithms: ["RS256"],
          verification: { iss: issuer, aud: audience },
        },
        // Workers does not support "error"; Hono rejects unfollowed redirects.
        { redirect: "manual" },
      );
      if (
        typeof identity.exp !== "number" ||
        !Number.isFinite(identity.exp) ||
        typeof identity.sub !== "string" ||
        !identity.sub ||
        typeof identity.email !== "string" ||
        !identity.email
      ) {
        throw new Error("Missing administrator identity claims");
      }
    } catch {
      // JWT/library failures can include the raw token. Never log or expose them.
      throw new HTTPException(401, {
        message: "Administrator authentication required",
      });
    }
  }
  context.set("adminAuthorized", true);
  await next();
};

export const requireAdminPage: MiddlewareHandler<AppBindings> = async (
  context,
  next,
) => {
  try {
    return await requireAdmin(context, next);
  } catch (error) {
    if (
      error instanceof HTTPException &&
      error.status === 401 &&
      isLocalDevelopment(context.env, new URL(context.req.url))
    ) {
      return context.redirect("/admin/login", 303);
    }
    throw error;
  }
};

export function createLocalAdminRoutes() {
  const routes = new Hono<AppBindings>();
  const localOnly: MiddlewareHandler<AppBindings> = async (context, next) => {
    if (!isLocalDevelopment(context.env, new URL(context.req.url)))
      throw new HTTPException(404, { message: "Route not found" });
    localSecret(context.env);
    await next();
  };
  routes.get("/admin/login", localOnly, (context) => {
    // Native form POSTs send Origin:null under no-referrer, defeating the origin guard.
    context.header("Referrer-Policy", "same-origin");
    context.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    return context.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local sign in · Linekeep</title><style>body{font:16px system-ui;color:#17352f;background:#F7F8F4;margin:0;padding:24px}main{max-width:420px;margin:12vh auto;background:white;padding:28px;border:1px solid #dce5dd;border-radius:12px}h1{display:flex;align-items:center;gap:12px;color:#103F3A}label,input,button{display:block}input{box-sizing:border-box;width:100%;margin:12px 0 20px;padding:12px;border:1px solid #a5bfb0;border-radius:6px;font:inherit}button{padding:12px 20px;border:0;border-radius:6px;background:#103F3A;color:white;font:inherit;cursor:pointer}:focus-visible{outline:3px solid #b56c11;outline-offset:3px}p{line-height:1.6}</style></head><body><main><h1>${linekeepMark}Linekeep</h1><h2>Local administrator sign in</h2><p>This sign-in works only on this development machine. Production access uses Cloudflare Access.</p><form action="/admin/session" method="post"><label for="secret">Local admin secret</label><input id="secret" name="secret" type="password" autocomplete="current-password" required maxlength="512"><button type="submit">Sign in</button></form></main></body></html>`,
    );
  });
  routes.post(
    "/admin/session",
    localOnly,
    bodyLimit({ maxSize: 2048 }),
    async (context) => {
      const url = new URL(context.req.url);
      if (
        context.req.header("Origin") !== url.origin ||
        context.req.header("Content-Type")?.split(";")[0].trim() !==
          "application/x-www-form-urlencoded"
      ) {
        throw new HTTPException(401, {
          message: "Administrator authentication required",
        });
      }
      const body = await context.req.parseBody();
      const secret = localSecret(context.env);
      if (
        typeof body.secret !== "string" ||
        body.secret.length > 512 ||
        !(await timingSafeEqual(body.secret, secret))
      ) {
        throw new HTTPException(401, {
          message: "Administrator authentication required",
        });
      }
      await setSignedCookie(
        context,
        localCookie,
        String(Date.now() + sessionLifetimeMs),
        `calltracker:local-admin-session:${secret}`,
        {
          path: "/",
          httpOnly: true,
          sameSite: "Strict",
          secure: url.protocol === "https:",
          maxAge: sessionLifetimeMs / 1000,
        },
      );
      return context.redirect("/admin", 303);
    },
  );
  return routes;
}
