import { Hono } from "hono";

import type { AppBindings } from "../app";
import { clientJavaScript } from "./client";
import { adminHtml } from "./page";
import { adminStyles } from "./styles";

export function createAdminUi(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Frame-Options", "DENY");
    context.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    context.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' https:; media-src 'self' https: blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    );
    await next();
  });

  app.get("/", (context) => context.html(adminHtml));
  app.get("/client.js", (context) =>
    context.body(clientJavaScript, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
    }),
  );
  app.get("/styles.css", (context) =>
    context.body(adminStyles, 200, {
      "Content-Type": "text/css; charset=utf-8",
    }),
  );

  return app;
}
