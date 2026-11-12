import { Hono } from "hono";

import type { AppBindings } from "../app";
import { webClientJavaScript } from "./client";
import { webAppHtml } from "./page";
import { webAppStyles } from "./styles";

/** Strict, same-origin only: the page loads one script and one stylesheet and talks to /v1/web. */
export const webAppContentSecurityPolicy =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

/**
 * Mount at /app. The shell and its assets are public by design: they contain no employee data, and every
 * /v1/web API they call is authenticated by the sign-in session. `/app/*` falls back to the shell so a
 * reload on any in-app address still works.
 */
export function createWebAppRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use("*", async (context, next) => {
    await next();
    context.header("Cache-Control", "no-store");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Frame-Options", "DENY");
    context.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    context.header("Content-Security-Policy", webAppContentSecurityPolicy);
  });

  app.get("/client.js", (context) =>
    context.body(webClientJavaScript, 200, { "Content-Type": "text/javascript; charset=utf-8" }));
  app.get("/styles.css", (context) =>
    context.body(webAppStyles, 200, { "Content-Type": "text/css; charset=utf-8" }));
  app.get("/", (context) => context.html(webAppHtml));
  app.get("/*", (context) => context.html(webAppHtml));

  return app;
}
