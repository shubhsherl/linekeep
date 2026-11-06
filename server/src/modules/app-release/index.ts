import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import type { AppBindings } from "../../app";
import { ApiError } from "../../http/errors";
import { qrSvg } from "../identity/enrollment-qr";
import { downloadPage, downloadPageSecurityPolicy } from "./download-page";
import {
  apkContentType, clearRelease, deleteAllReleases, fileNameFor, maxApkBytes, minApkBytes, objectKeyFor, pruneReleases,
  readReleaseState, saveLatest, saveSharing, versionPattern, type AppRelease, type ReleaseState,
} from "./release";

const invalid = (message: string) => new ApiError(400, "INVALID_REQUEST", message);
const sharingBody = z.strictObject({ publicDownload: z.boolean() });
const zipMagic = [0x50, 0x4b, 0x03, 0x04];

const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");

function view(origin: string, state: ReleaseState) {
  return {
    latest: state.latest,
    publicDownload: state.publicDownload,
    downloadPageUrl: `${origin}/download`,
    apkUrl: `${origin}/download/linekeep.apk`,
    maxBytes: maxApkBytes,
  };
}

/** Streams the stored APK (or just its headers for HEAD) with the headers an installer download needs. */
async function serveApk(context: Context<AppBindings>, release: AppRelease): Promise<Response> {
  const bucket = context.env.RECORDINGS;
  const headers = new Headers({
    "Content-Type": apkContentType,
    "Content-Disposition": `attachment; filename="${fileNameFor(release)}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
  });
  if (context.req.method === "HEAD") {
    const head = await bucket.head(release.objectKey);
    if (!head) return context.notFound();
    headers.set("ETag", head.httpEtag);
    headers.set("Content-Length", String(head.size));
    return new Response(null, { headers });
  }
  const range = context.req.header("Range");
  const object = await bucket.get(release.objectKey, range ? { range: context.req.raw.headers } : undefined);
  if (!object) return context.notFound();
  headers.set("ETag", object.httpEtag);
  if (range && object.range && "offset" in object.range && object.range.offset !== undefined) {
    const offset = object.range.offset;
    const length = object.range.length ?? object.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

/** Stores the request body as the new release, hashing it on the way through. Nothing is buffered. */
async function receiveApk(context: Context<AppBindings>): Promise<AppRelease> {
  const versionName = context.req.query("versionName") ?? "";
  if (!versionPattern.test(versionName)) {
    throw invalid("versionName must be 1-32 characters: letters, digits, '.', '+', '_' or '-', starting with a letter or digit");
  }
  const contentType = (context.req.header("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== apkContentType && contentType !== "application/octet-stream") {
    throw invalid(`Send the file as ${apkContentType} or application/octet-stream`);
  }
  const declared = context.req.header("Content-Length");
  if (!declared || !/^\d{1,12}$/.test(declared)) throw invalid("Content-Length is required");
  const length = Number(declared);
  if (length > maxApkBytes) throw new ApiError(413, "FILE_TOO_LARGE", `The APK must be at most ${maxApkBytes / (1024 * 1024)} MB`);
  if (length < minApkBytes) throw invalid("That file is too small to be an APK");
  const body = context.req.raw.body;
  if (!body) throw invalid("The APK file is required");

  const objectKey = objectKeyFor(versionName);
  // The Workers runtime exposes DigestStream on `crypto`; the WebWorker lib's `Crypto` type does not declare it.
  const digest = new (crypto as unknown as { DigestStream: typeof DigestStream }).DigestStream("SHA-256");
  digest.digest.catch(() => {});
  const digestWriter = digest.getWriter();
  const head = new Uint8Array(zipMagic.length);
  let headLength = 0;
  let rejection: ApiError | undefined;
  const inspect = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      if (headLength < head.length) {
        const take = Math.min(head.length - headLength, chunk.byteLength);
        head.set(chunk.subarray(0, take), headLength);
        headLength += take;
        if (headLength === head.length && !zipMagic.every((byte, index) => head[index] === byte)) {
          rejection = invalid("That file is not an APK (it is not a ZIP archive)");
          throw rejection;
        }
      }
      await digestWriter.write(chunk);
      controller.enqueue(chunk);
    },
    async flush() {
      await digestWriter.close();
    },
  });

  const fixed = new FixedLengthStream(length);
  const transfer = body.pipeThrough(inspect).pipeTo(fixed.writable);
  const put = context.env.RECORDINGS.put(objectKey, fixed.readable, { httpMetadata: { contentType: apkContentType } }).catch(
    async (error: unknown) => {
      await fixed.readable.cancel(error).catch(() => {});
      throw error;
    },
  );
  const [stored, transferred] = await Promise.allSettled([put, transfer]);
  if (rejection) throw rejection;
  if (transferred.status === "rejected") {
    digestWriter.abort().catch(() => {});
    throw invalid("The upload was interrupted or did not match Content-Length");
  }
  if (stored.status === "rejected") throw stored.reason;

  const release: AppRelease = {
    versionName,
    size: stored.value.size,
    sha256: hex(await digest.digest),
    uploadedAt: stored.value.uploaded.toISOString(),
    objectKey,
  };
  const previous = (await readReleaseState(context.env.DB)).latest;
  try {
    await saveLatest(context.env, release);
  } catch (error) {
    // Re-uploading the current version overwrote it in place; any other new object has no record, so drop it.
    if (previous?.objectKey !== objectKey) await context.env.RECORDINGS.delete(objectKey).catch(() => {});
    throw error;
  }
  // Pruning is housekeeping: the upload already succeeded and the next upload retries it.
  await pruneReleases(context.env.RECORDINGS, objectKey).catch(() => {});
  return release;
}

/** Mount at /v1/admin; callers must supply the existing administrator guard. */
export function createAdminAppRoutes(authorize: MiddlewareHandler<AppBindings>) {
  if (typeof authorize !== "function") throw new TypeError("Admin authorization is required");
  const routes = new Hono<AppBindings>();
  routes.use("/app", authorize);
  routes.use("/app/*", authorize);

  const respond = async (context: Context<AppBindings>) =>
    context.json({ requestId: context.get("requestId"), ...view(new URL(context.req.url).origin, await readReleaseState(context.env.DB)) });

  routes.get("/app", respond);

  routes.put("/app/apk", async (context) => {
    await receiveApk(context);
    return respond(context);
  });

  routes.get("/app/apk", async (context) => {
    const { latest } = await readReleaseState(context.env.DB);
    if (!latest) throw new ApiError(404, "NOT_FOUND", "No APK has been uploaded");
    return serveApk(context, latest);
  });

  routes.delete("/app/apk", async (context) => {
    await clearRelease(context.env);
    await deleteAllReleases(context.env.RECORDINGS);
    return respond(context);
  });

  routes.put("/app/sharing", bodyLimit({ maxSize: 1024 }), async (context) => {
    const { publicDownload } = sharingBody.parse(await context.req.json());
    if (publicDownload && !(await readReleaseState(context.env.DB)).latest) throw invalid("Upload an APK before turning sharing on");
    await saveSharing(context.env, publicDownload);
    return respond(context);
  });

  routes.get("/app/qr.svg", async (context) => {
    const { latest } = await readReleaseState(context.env.DB);
    if (!latest) throw new ApiError(404, "NOT_FOUND", "No APK has been uploaded");
    return new Response(qrSvg(`${new URL(context.req.url).origin}/download`), {
      headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Content-Disposition": 'inline; filename="linekeep-download-qr.svg"' },
    });
  });

  return routes;
}

/** Mount at the root. Anyone may call these, but only while an administrator has turned sharing on. */
export function createPublicDownloadRoutes() {
  const routes = new Hono<AppBindings>();

  routes.get("/download", async (context) => {
    const { latest, publicDownload } = await readReleaseState(context.env.DB);
    if (!latest || !publicDownload) return context.notFound();
    context.header("Content-Security-Policy", downloadPageSecurityPolicy);
    context.header("X-Frame-Options", "DENY");
    context.header("X-Robots-Tag", "noindex, nofollow");
    return context.html(downloadPage(latest));
  });

  routes.on(["GET", "HEAD"], "/download/linekeep.apk", async (context) => {
    const { latest, publicDownload } = await readReleaseState(context.env.DB);
    if (!latest || !publicDownload) return context.notFound();
    return serveApk(context, latest);
  });

  return routes;
}
