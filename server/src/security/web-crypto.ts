const encoder = new TextEncoder();

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Separate keys for separate jobs: a value hashed for one purpose can never be replayed as another. */
export type WebPurpose = "session" | "csrf" | "otp" | "email" | "ip";

export interface WebCrypto {
  /** HMAC-SHA256 of `value` under the purpose's key, as lower-case hex. */
  mac(purpose: WebPurpose, value: string): Promise<string>;
  /** 256 random bits as hex. */
  token(): string;
  /** Six uniformly random digits. */
  code(): string;
}

const instances = new Map<string, WebCrypto>();

/**
 * Keyed hashing and randomness for the employee web app. Every key is derived (HKDF) from TOKEN_HASH_SECRET with
 * a per-purpose label and used only to sign, never exported.
 */
export function webCrypto(secret: string | undefined): WebCrypto {
  if (typeof secret !== "string" || encoder.encode(secret).byteLength < 32) {
    throw new Error("TOKEN_HASH_SECRET must contain at least 32 bytes");
  }
  let instance = instances.get(secret);
  if (!instance) {
    instance = build(secret);
    instances.set(secret, instance);
  }
  return instance;
}

function build(secret: string): WebCrypto {
  const root = crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveBits"]);
  const keys = new Map<WebPurpose, Promise<CryptoKey>>();
  const key = (purpose: WebPurpose): Promise<CryptoKey> => {
    let derived = keys.get(purpose);
    if (!derived) {
      derived = root.then(async (material) => crypto.subtle.importKey(
        "raw",
        await crypto.subtle.deriveBits(
          { name: "HKDF", hash: "SHA-256", salt: encoder.encode("linekeep:web:v1"), info: encoder.encode(purpose) },
          material, 256,
        ),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
      ));
      keys.set(purpose, derived);
    }
    return derived;
  };
  return {
    /** HMAC-SHA256 of `value` under the purpose's key, as lower-case hex. */
    async mac(purpose: WebPurpose, value: string): Promise<string> {
      return hex(new Uint8Array(await crypto.subtle.sign("HMAC", await key(purpose), encoder.encode(value))));
    },
    /** 256 random bits as hex. */
    token: () => hex(crypto.getRandomValues(new Uint8Array(32))),
    /**
     * Six digits, uniform: values past the largest multiple of a million are redrawn instead of folded back,
     * which would favour small codes.
     */
    code(): string {
      const limit = Math.floor(2 ** 32 / 1_000_000) * 1_000_000;
      const draw = new Uint32Array(1);
      do crypto.getRandomValues(draw); while (draw[0] >= limit);
      return String(draw[0] % 1_000_000).padStart(6, "0");
    },
  };
}

/** Compares two strings without stopping at the first difference. */
export function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
