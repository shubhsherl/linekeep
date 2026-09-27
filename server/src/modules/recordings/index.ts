import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import {
  createCallRepository,
  InvalidCallStateError,
  type CallRecord,
} from "../../data/calls";
import {
  nonnegativeInteger,
  positiveInteger,
  utcTimestamp,
} from "../../data/values";
import type { Env } from "../../env";
import { requireDevice, type DeviceBindings } from "../identity";
import { signMediaCapability, verifyMediaCapability } from "./capabilities";

const prepareInput = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  file: z.object({
    displayName: z.string().trim().min(1).max(1024),
    contentType: z.enum(["audio/mp4", "audio/mpeg", "audio/wav"]),
    expectedBytes: positiveInteger,
    durationSeconds: nonnegativeInteger.optional(),
    recordedAt: utcTimestamp.optional(),
  }),
  call: z.object({
    remoteNumber: z.string().max(256).optional(),
    direction: z.enum(["incoming", "outgoing", "unknown"]).optional(),
    matchStatus: z.enum([
      "filename",
      "media_metadata",
      "call_log",
      "unmatched",
    ]),
  }),
});
const completeInput = z.object({
  actualBytes: positiveInteger,
  etag: z.string().min(1).max(256).optional(),
});

function maximumBytes(env: Env): number {
  const maximum = Number(env.MAX_RECORDING_BYTES);
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new HTTPException(500, {
      message: "Recording configuration is unavailable",
    });
  }
  return maximum;
}

async function activeOwner(env: Env, call: CallRecord): Promise<boolean> {
  return createCallRepository(env.DB).isActiveOwner(call.id);
}

function verifyObject(
  call: CallRecord,
  object: R2Object | null,
  actualBytes: number,
  etag?: string,
): asserts object is R2Object {
  if (!object)
    throw new HTTPException(409, { message: "Recording audio is missing" });
  if (
    object.size !== call.expectedBytes ||
    object.size !== actualBytes ||
    object.httpMetadata?.contentType !== call.contentType
  ) {
    throw new HTTPException(409, {
      message: "Recording audio does not match prepared metadata",
    });
  }
  const normalizedEtag = etag?.replace(/^"(.*)"$/, "$1");
  if (normalizedEtag !== undefined && normalizedEtag !== object.etag) {
    throw new HTTPException(409, { message: "Recording ETag does not match" });
  }
}

/** Count actual stream bytes, keeping only the current chunk; never buffer a recording. */
async function transferBody(
  body: ReadableStream<Uint8Array>,
  expected: number,
  maximum: number,
  writer?: WritableStreamDefaultWriter<Uint8Array>,
) {
  const reader = body.getReader();
  let count = 0;
  // Withhold the last byte until EOF is verified: R2 must not commit an
  // expected-length prefix before a later chunk reveals an oversized body.
  const finalByte = writer ? new Uint8Array(1) : undefined;
  let hasFinalByte = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > maximum)
        throw new HTTPException(413, {
          message: "Recording exceeds the size limit",
        });
      if (count > expected)
        throw new HTTPException(400, {
          message: "Recording byte count does not match",
        });
      if (writer && finalByte && value.byteLength > 0) {
        if (hasFinalByte) await writer.write(finalByte);
        if (value.byteLength > 1) await writer.write(value.subarray(0, -1));
        finalByte[0] = value[value.byteLength - 1];
        hasFinalByte = true;
      }
    }
    if (count !== expected)
      throw new HTTPException(400, {
        message: "Recording byte count does not match",
      });
    if (writer && finalByte) {
      await writer.write(finalByte);
      await writer.close();
    }
  } catch (error) {
    await Promise.allSettled([
      reader.cancel(error),
      ...(writer ? [writer.abort(error)] : []),
    ]);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function createRecordingRoutes(): Hono<DeviceBindings> {
  const routes = new Hono<DeviceBindings>();

  routes.post("/prepare", requireDevice, async (c) => {
    const value = prepareInput.parse(await c.req.json());
    if (value.file.expectedBytes > maximumBytes(c.env)) {
      throw new HTTPException(413, {
        message: "Recording exceeds the size limit",
      });
    }
    const calls = createCallRepository(c.env.DB);
    let call = await calls.createPending({
      deviceId: c.get("device").id,
      fingerprint: value.fingerprint,
      ...value.file,
      ...value.call,
    });
    if (!call)
      throw new HTTPException(401, {
        message: "Device authorization is required",
      });
    if (call.uploadStatus === "deleted")
      throw new HTTPException(409, { message: "Recording has been deleted" });
    if (call.uploadStatus === "failed") {
      const failedCall = call;
      try {
        call = await calls.retryFailed(failedCall.id, failedCall.deviceId);
      } catch (error) {
        if (!(error instanceof InvalidCallStateError)) throw error;
        call = await calls.getForDevice(failedCall.id, failedCall.deviceId);
      }
      if (
        !call ||
        call.uploadStatus === "deleted" ||
        call.uploadStatus === "failed"
      ) {
        throw new HTTPException(409, {
          message: "Recording cannot be retried",
        });
      }
    }
    if (call.uploadStatus === "complete") {
      return c.json({
        requestId: c.get("requestId"),
        callId: call.id,
        status: "complete",
      });
    }
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const signature = await signMediaCapability(
      c.env.TOKEN_HASH_SECRET ?? "",
      "PUT",
      call.objectKey,
      expiresAt,
    );
    const url = new URL(
      `/v1/device/uploads/${encodeURIComponent(call.id)}/audio`,
      c.req.url,
    );
    url.searchParams.set("expiresAt", expiresAt);
    url.searchParams.set("signature", signature);
    c.header("Cache-Control", "no-store");
    return c.json({
      requestId: c.get("requestId"),
      callId: call.id,
      status: "pending",
      upload: {
        method: "PUT",
        url: url.href,
        expiresAt,
        headers: { "Content-Type": call.contentType },
      },
    });
  });

  routes.put("/:callId/audio", async (c) => {
    const calls = createCallRepository(c.env.DB);
    const call = await calls.getById(c.req.param("callId"));
    if (
      !call ||
      !(await verifyMediaCapability(
        c.env.TOKEN_HASH_SECRET ?? "",
        "PUT",
        call.objectKey,
        c.req.query("expiresAt") ?? "",
        c.req.query("signature") ?? "",
      ))
    ) {
      throw new HTTPException(401, {
        message: "Upload authorization is invalid or expired",
      });
    }
    if (!(await activeOwner(c.env, call)))
      throw new HTTPException(401, {
        message: "Device authorization is required",
      });
    if (call.uploadStatus !== "pending" && call.uploadStatus !== "complete") {
      throw new HTTPException(409, {
        message: "Recording cannot receive audio",
      });
    }
    const maximum = maximumBytes(c.env);
    if (call.expectedBytes > maximum)
      throw new HTTPException(413, {
        message: "Recording exceeds the size limit",
      });
    if (c.req.header("Content-Type") !== call.contentType)
      throw new HTTPException(400, {
        message: "Recording content type does not match",
      });
    const length = c.req.header("Content-Length");
    if (
      length !== undefined &&
      (!/^\d+$/.test(length) || Number(length) !== call.expectedBytes)
    ) {
      throw new HTTPException(Number(length) > maximum ? 413 : 400, {
        message: "Recording byte count does not match",
      });
    }
    const body = c.req.raw.body;
    if (!body)
      throw new HTTPException(400, { message: "Recording audio is required" });
    let object = await c.env.RECORDINGS.head(call.objectKey);
    let created = false;
    if (object) {
      // A lost successful response may be retried, but no capability may replace those bytes.
      await transferBody(body, call.expectedBytes, maximum);
      verifyObject(call, object, call.expectedBytes);
    } else {
      if (call.uploadStatus === "complete")
        throw new HTTPException(409, {
          message: "Completed recording audio is missing",
        });
      const stream = new FixedLengthStream(call.expectedBytes);
      const writer = stream.writable.getWriter();
      const transfer = transferBody(body, call.expectedBytes, maximum, writer);
      const put = c.env.RECORDINGS.put(call.objectKey, stream.readable, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: call.contentType },
      }).then(
        async (result) => {
          if (!result) {
            // A competing upload won. R2 may stop reading without draining the input.
            await stream.readable.cancel().catch(() => {});
          }
          return result;
        },
        async (error: unknown) => {
          await stream.readable.cancel(error).catch(() => {});
          throw error;
        },
      );
      const [uploaded, transferred] = await Promise.allSettled([put, transfer]);
      if (uploaded.status === "rejected") {
        if (
          transferred.status === "rejected" &&
          transferred.reason instanceof HTTPException
        )
          throw transferred.reason;
        throw uploaded.reason;
      }
      object = uploaded.value;
      created = object !== null;
      if (!object) {
        throw new HTTPException(409, {
          message: "Another upload already supplied recording audio",
        });
      } else if (transferred.status === "rejected") {
        // Failed streams cannot commit an R2 object. Do not delete a concurrent winner.
        throw transferred.reason;
      }
    }
    const latest = await calls.getById(call.id);
    const active = await activeOwner(c.env, call);
    if (!latest || latest.uploadStatus === "deleted" || !active) {
      // Cleanup only our committed write, and preserve a concurrently completed upload.
      if (created && latest?.uploadStatus !== "complete") {
        await c.env.RECORDINGS.delete(call.objectKey);
      }
      throw new HTTPException(!active ? 401 : 409, {
        message: "Recording upload is no longer authorized",
      });
    }
    if (
      latest.uploadStatus !== "pending" &&
      latest.uploadStatus !== "complete"
    ) {
      throw new HTTPException(409, {
        message: "Recording cannot receive audio",
      });
    }
    verifyObject(call, object, call.expectedBytes);
    c.header("ETag", object.httpEtag);
    c.header("Cache-Control", "no-store");
    return c.body(null, 200);
  });

  routes.post("/:callId/complete", requireDevice, async (c) => {
    const value = completeInput.parse(await c.req.json());
    const calls = createCallRepository(c.env.DB);
    const call = await calls.getForDevice(
      c.req.param("callId"),
      c.get("device").id,
    );
    if (!call)
      throw new HTTPException(404, { message: "Recording was not found" });
    if (!(await activeOwner(c.env, call)))
      throw new HTTPException(401, {
        message: "Device authorization is required",
      });
    if (call.uploadStatus === "complete") {
      return c.json({
        requestId: c.get("requestId"),
        callId: call.id,
        status: "complete",
        uploadedAt: call.uploadedAt,
      });
    }
    if (call.uploadStatus !== "pending")
      throw new HTTPException(409, {
        message: "Recording cannot be completed",
      });
    const object = await c.env.RECORDINGS.head(call.objectKey);
    verifyObject(call, object, value.actualBytes, value.etag);
    if (!(await activeOwner(c.env, call)))
      throw new HTTPException(401, {
        message: "Device authorization is required",
      });
    let completed: CallRecord | null;
    try {
      completed = await calls.complete(call.id, call.deviceId, {
        actualBytes: object.size,
        etag: object.etag,
      });
    } catch (error) {
      if (error instanceof InvalidCallStateError)
        throw new HTTPException(409, {
          message: "Recording cannot be completed",
        });
      throw error;
    }
    if (!completed)
      throw new HTTPException(404, { message: "Recording was not found" });
    return c.json({
      requestId: c.get("requestId"),
      callId: completed.id,
      status: "complete",
      uploadedAt: completed.uploadedAt,
    });
  });
  return routes;
}
