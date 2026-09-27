import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { AppBindings } from "../../app";
import {
  adminCallDto as callDto,
  createCallRepository,
  type CallCursor,
  type CallRecord,
} from "../../data/calls";
import { utcTimestamp } from "../../data/values";
import {
  signMediaCapability,
  verifyMediaCapability,
} from "../recordings/capabilities";

const playbackLifetimeMs = 5 * 60 * 1000;
const callIdInput = z.string().min(1).max(256);
const cursorInput = z.strictObject({ sortAt: utcTimestamp, id: callIdInput });
const listInput = z
  .strictObject({
    employeeId: callIdInput.optional(),
    direction: z.enum(["incoming", "outgoing", "unknown"]).optional(),
    number: z.string().max(256).optional(),
    from: utcTimestamp.optional(),
    to: utcTimestamp.optional(),
    status: z.enum(["pending", "complete", "failed", "deleted"]).optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to);
const audioInput = z.strictObject({
  expiresAt: z.string().min(1).max(32),
  signature: z.string().min(1).max(128),
  download: z.literal("1").optional(),
});

function queryValues(url: string, omitEmpty = false) {
  const values: Record<string, string> = Object.create(null);
  for (const [key, value] of new URL(url).searchParams) {
    if (Object.hasOwn(values, key)) {
      throw new HTTPException(400, { message: "Invalid query parameters" });
    }
    values[key] = value;
  }
  if (omitEmpty) {
    for (const key of Object.keys(values)) {
      if (values[key] === "") delete values[key];
    }
  }
  return values;
}

function encodeCursor(cursor: CallCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeCursor(encoded: string): CallCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const bytes = Uint8Array.from(
      atob(encoded.replaceAll("-", "+").replaceAll("_", "/")),
      (character) => character.charCodeAt(0),
    );
    const cursor = cursorInput.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (encodeCursor(cursor) !== encoded) throw new Error();
    return cursor;
  } catch {
    throw new HTTPException(400, { message: "Invalid pagination cursor" });
  }
}


function completed(call: CallRecord | null): CallRecord {
  if (!call || call.uploadStatus === "deleted") {
    throw new HTTPException(404, { message: "Recording not found" });
  }
  if (call.uploadStatus !== "complete") {
    throw new HTTPException(409, { message: "Recording is not complete" });
  }
  return call;
}

function disposition(displayName: string, download: boolean): string {
  // Both filename forms remove paths and controls; the ASCII fallback cannot inject headers.
  const name =
    displayName
      .replace(/[\u0000-\u001f\u007f-\u009f/\\]/g, "_")
      .slice(0, 180) || "recording";
  const ascii = name.replace(/[^a-zA-Z0-9 ._-]/g, "_");
  const encoded = encodeURIComponent(
    new TextDecoder().decode(new TextEncoder().encode(name)),
  ).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function byteRange(
  header: string,
  size: number,
): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(end) ||
    offset >= size ||
    end < offset
  )
    return null;
  return { offset, length: Math.min(end, size - 1) - offset + 1 };
}

/** Mount at /v1/admin. Authorization is required, including capability-backed media requests. */
export function createAdminCallRoutes(
  authorize: MiddlewareHandler<AppBindings>,
): Hono<AppBindings> {
  if (typeof authorize !== "function")
    throw new TypeError("Admin authorization is required");
  const routes = new Hono<AppBindings>();
  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "private, no-store");
    context.header("Pragma", "no-cache");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  routes.use("*", authorize);

  routes.get("/calls", async (context) => {
    const input = listInput.parse(queryValues(context.req.url, true));
    const result = await createCallRepository(context.env.DB).list({
      ...input,
      cursor: input.cursor ? decodeCursor(input.cursor) : undefined,
    });
    return context.json({
      requestId: context.get("requestId"),
      items: result.items.map(callDto),
      nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
    });
  });

  routes.post("/calls/:callId/playback", async (context) => {
    const call = completed(
      await createCallRepository(context.env.DB).getById(
        callIdInput.parse(context.req.param("callId")),
      ),
    );
    if (!(await context.env.RECORDINGS.head(call.objectKey))) {
      throw new HTTPException(404, { message: "Recording audio not found" });
    }
    const expiresAt = new Date(Date.now() + playbackLifetimeMs).toISOString();
    const signature = await signMediaCapability(
      context.env.TOKEN_HASH_SECRET ?? "",
      "GET",
      call.objectKey,
      expiresAt,
    );
    const url = new URL(context.req.url);
    url.pathname = `${url.pathname.slice(0, -"playback".length)}audio`;
    url.search = "";
    url.searchParams.set("expiresAt", expiresAt);
    url.searchParams.set("signature", signature);
    return context.json({
      requestId: context.get("requestId"),
      url: url.toString(),
      expiresAt,
      contentType: call.contentType,
    });
  });

  routes.on(["GET", "HEAD"], "/calls/:callId/audio", async (context) => {
    const call = completed(
      await createCallRepository(context.env.DB).getById(
        callIdInput.parse(context.req.param("callId")),
      ),
    );
    const parsed = audioInput.safeParse(queryValues(context.req.url));
    if (
      !parsed.success ||
      !(await verifyMediaCapability(
        context.env.TOKEN_HASH_SECRET ?? "",
        "GET",
        call.objectKey,
        parsed.data.expiresAt,
        parsed.data.signature,
      ))
    ) {
      throw new HTTPException(401, {
        message: "Invalid or expired playback capability",
      });
    }
    const object = await context.env.RECORDINGS.head(call.objectKey);
    if (!object)
      throw new HTTPException(404, { message: "Recording audio not found" });
    context.header("Content-Type", call.contentType);
    context.header("ETag", object.httpEtag);
    context.header("Accept-Ranges", "bytes");
    context.header(
      "Content-Disposition",
      disposition(call.displayName, parsed.data.download === "1"),
    );
    context.header("Last-Modified", object.uploaded.toUTCString());
    if (context.req.method === "HEAD") {
      context.header("Content-Length", String(object.size));
      return context.body(null, 200);
    }

    const rangeHeader = context.req.header("Range");
    const ifRange = context.req.header("If-Range");
    // A stale validator requires the complete representation, not bytes from a different object.
    const useRange =
      rangeHeader !== undefined &&
      (!ifRange ||
        ifRange === object.httpEtag ||
        Date.parse(ifRange) >=
          Math.floor(object.uploaded.getTime() / 1000) * 1000);
    const range = useRange ? byteRange(rangeHeader, object.size) : undefined;
    if (range === null) {
      context.header("Content-Range", `bytes */${object.size}`);
      context.header("Content-Length", "0");
      return context.body(null, 416);
    }
    const stored = await context.env.RECORDINGS.get(call.objectKey, {
      onlyIf: { etagMatches: object.etag },
      ...(range ? { range } : {}),
    });
    if (!stored)
      throw new HTTPException(404, { message: "Recording audio not found" });
    if (!("body" in stored))
      throw new HTTPException(409, { message: "Recording audio changed" });
    context.header(
      "Content-Length",
      String(range ? range.length : stored.size),
    );
    if (range)
      context.header(
        "Content-Range",
        `bytes ${range.offset}-${range.offset + range.length - 1}/${stored.size}`,
      );
    return context.body(stored.body, range ? 206 : 200);
  });

  routes.delete("/calls/:callId", async (context) => {
    const callId = callIdInput.parse(context.req.param("callId"));
    const calls = createCallRepository(context.env.DB);
    const call = await calls.getById(callId);
    if (call) {
      // R2 delete is idempotent. Keep the key/tombstone so a failed D1 update can be retried.
      await context.env.RECORDINGS.delete(call.objectKey);
      await calls.markDeleted(callId);
      // Close an in-flight PUT between the first deletion and the tombstone.
      await context.env.RECORDINGS.delete(call.objectKey);
    }
    return context.json({
      requestId: context.get("requestId"),
      callId,
      status: "deleted",
    });
  });

  return routes;
}
