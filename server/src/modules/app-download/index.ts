import { Hono, type MiddlewareHandler } from "hono";

import type { AppBindings } from "../../app";
import { qrSvg } from "../identity/enrollment-qr";
import { communityApkUrl } from "./community-build";
import { downloadPage, downloadPageSecurityPolicy } from "./download-page";

/** Mount at /v1/admin; callers must supply the existing administrator guard. */
export function createAdminAppRoutes(authorize: MiddlewareHandler<AppBindings>) {
  if (typeof authorize !== "function") throw new TypeError("Admin authorization is required");
  const routes = new Hono<AppBindings>();
  routes.use("/app", authorize);
  routes.use("/app/*", authorize);

  routes.get("/app/qr.svg", (context) =>
    new Response(qrSvg(`${new URL(context.req.url).origin}/download`), {
      headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Content-Disposition": 'inline; filename="linekeep-download-qr.svg"' },
    }));

  return routes;
}

/**
 * Mount at the root. Always public and stateless: the page names the community build and the APK path
 * redirects to the GitHub release, so the server stores and serves no APK itself.
 */
export function createPublicDownloadRoutes() {
  const routes = new Hono<AppBindings>();

  routes.get("/download", (context) => {
    context.header("Content-Security-Policy", downloadPageSecurityPolicy);
    context.header("X-Frame-Options", "DENY");
    context.header("X-Robots-Tag", "noindex, nofollow");
    return context.html(downloadPage);
  });

  routes.on(["GET", "HEAD"], "/download/linekeep.apk", (context) => {
    context.header("Cache-Control", "no-store");
    return context.redirect(communityApkUrl, 302);
  });

  return routes;
}
