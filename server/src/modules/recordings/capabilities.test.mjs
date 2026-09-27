import assert from "node:assert/strict";
import test from "node:test";

import { loadModule } from "../../data/test-support.mjs";

const { signMediaCapability, verifyMediaCapability } = await loadModule(
  "../modules/recordings/capabilities.ts",
);
const secret = "synthetic-media-secret-not-for-deployment";
const expiresAt = "2026-09-24T13:00:00.000Z";
const beforeExpiry = Date.parse(expiresAt) - 1;
const objectKey = "recordings/emp_synthetic/2026/09/call_synthetic";

test("capabilities bind method, object, secret and canonical expiry and expire at the boundary", async () => {
  const signature = await signMediaCapability(
    secret,
    "PUT",
    objectKey,
    expiresAt,
  );
  assert.equal(
    await verifyMediaCapability(
      secret,
      "PUT",
      objectKey,
      expiresAt,
      signature,
      beforeExpiry,
    ),
    true,
  );
  assert.equal(
    await verifyMediaCapability(
      secret,
      "GET",
      objectKey,
      expiresAt,
      signature,
      beforeExpiry,
    ),
    false,
  );
  assert.equal(
    await verifyMediaCapability(
      secret,
      "PUT",
      `${objectKey}-other`,
      expiresAt,
      signature,
      beforeExpiry,
    ),
    false,
  );
  assert.equal(
    await verifyMediaCapability(
      `${secret}-other`,
      "PUT",
      objectKey,
      expiresAt,
      signature,
      beforeExpiry,
    ),
    false,
  );
  assert.equal(
    await verifyMediaCapability(
      secret,
      "PUT",
      objectKey,
      "2026-09-24T13:01:00.000Z",
      signature,
      beforeExpiry,
    ),
    false,
  );
  assert.equal(
    await verifyMediaCapability(
      secret,
      "PUT",
      objectKey,
      expiresAt,
      `${signature[0] === "0" ? "1" : "0"}${signature.slice(1)}`,
      beforeExpiry,
    ),
    false,
  );
  assert.equal(
    await verifyMediaCapability(
      secret,
      "PUT",
      objectKey,
      expiresAt,
      signature,
      Date.parse(expiresAt),
    ),
    false,
  );
  assert.equal(
    await verifyMediaCapability(
      secret,
      "PUT",
      objectKey,
      expiresAt,
      signature,
      Date.parse(expiresAt) + 1,
    ),
    false,
  );
  assert.equal(
    await verifyMediaCapability(
      secret,
      "PUT",
      objectKey,
      "2026-09-24T13:00:00Z",
      signature,
      beforeExpiry,
    ),
    false,
  );
  assert.equal(
    await verifyMediaCapability(
      secret,
      "PUT",
      objectKey,
      "invalid",
      signature,
      beforeExpiry,
    ),
    false,
  );
  const readSignature = await signMediaCapability(
    secret,
    "GET",
    objectKey,
    expiresAt,
  );
  assert.equal(
    await verifyMediaCapability(
      secret,
      "GET",
      objectKey,
      expiresAt,
      readSignature,
      beforeExpiry,
    ),
    true,
  );
});

test("signing refuses weak keys and noncanonical timestamps instead of minting ambiguous capabilities", async () => {
  await assert.rejects(
    signMediaCapability("short", "PUT", objectKey, expiresAt),
  );
  await assert.rejects(
    signMediaCapability(secret, "PUT", objectKey, "2026-09-24T13:00:00+00:00"),
  );
  await assert.rejects(
    signMediaCapability(secret, "PUT", objectKey, "2026-09-24T13:00:00Z"),
  );
});
