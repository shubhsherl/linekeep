const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

/** A Worker-lifetime service; the HMAC key is imported once and never exported. */
export function createCredentials(secret: string) {
  if (typeof secret !== "string" || encoder.encode(secret).byteLength < 32) {
    throw new Error("TOKEN_HASH_SECRET must contain at least 32 bytes");
  }

  const key = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  async function hash(purpose: "device" | "invitation", value: string) {
    const signature = await crypto.subtle.sign(
      "HMAC",
      await key,
      encoder.encode(`calltracker:${purpose}:${value}`),
    );
    return hex(new Uint8Array(signature));
  }

  return {
    async issueDeviceToken() {
      const token = `ctd_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
      return { token, hash: await hash("device", token) };
    },
    async issueInvitationCode() {
      const code = `join_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
      return { code, hash: await hash("invitation", code) };
    },
    hashDeviceToken: (token: string) => hash("device", token),
    hashInvitationCode: (code: string) => hash("invitation", code),
  };
}
