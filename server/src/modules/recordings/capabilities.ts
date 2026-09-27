const encoder = new TextEncoder();
const domain = "calltracker:media-capability:v1";

function payload(method: "PUT" | "GET", objectKey: string, expiresAt: string) {
  const expiry = Date.parse(expiresAt);
  if (
    !Number.isFinite(expiry) ||
    new Date(expiry).toISOString() !== expiresAt ||
    !objectKey ||
    (method !== "PUT" && method !== "GET")
  ) {
    throw new TypeError("Invalid media capability");
  }
  return encoder.encode(JSON.stringify([domain, method, objectKey, expiresAt]));
}

async function key(secret: string) {
  const bytes = encoder.encode(secret);
  if (bytes.byteLength < 32)
    throw new Error("Media signing secret is unavailable");
  return crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signMediaCapability(
  secret: string,
  method: "PUT" | "GET",
  objectKey: string,
  expiresAt: string,
): Promise<string> {
  const bytes = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    payload(method, objectKey, expiresAt),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function verifyMediaCapability(
  secret: string,
  method: "PUT" | "GET",
  objectKey: string,
  expiresAt: string,
  signature: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (
    !/^[0-9a-f]{64}$/.test(signature) ||
    !Number.isFinite(nowMs) ||
    Date.parse(expiresAt) <= nowMs
  )
    return false;
  let data: Uint8Array<ArrayBuffer>;
  try {
    data = payload(method, objectKey, expiresAt);
  } catch {
    return false;
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(
      signature.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return crypto.subtle.verify("HMAC", await key(secret), bytes, data);
}
