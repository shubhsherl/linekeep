const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const version = "v1";
// Distinct from every other use of TOKEN_HASH_SECRET (the device-token HMAC), so keys never overlap.
const hkdfSalt = encoder.encode("linekeep-settings-salt");
const hkdfInfo = encoder.encode("linekeep:settings:aes-256-gcm:v1");

export class SettingsCryptoError extends Error {}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new SettingsCryptoError("Malformed ciphertext");
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** True when TOKEN_HASH_SECRET can seed the encryption key (same minimum as the credential HMAC). */
export function canEncrypt(secret: string | undefined): secret is string {
  return typeof secret === "string" && encoder.encode(secret).byteLength >= 32;
}

/**
 * AES-256-GCM with a key derived from TOKEN_HASH_SECRET via HKDF-SHA256. Each value gets a fresh random
 * 96-bit IV, and the setting's key name is the additional authenticated data, so a ciphertext copied to a
 * different key (or tampered with) fails to decrypt. Format: `v1.<iv>.<ciphertext+tag>`, base64url.
 */
export async function createSettingsCipher(secret: string) {
  if (!canEncrypt(secret)) throw new SettingsCryptoError("TOKEN_HASH_SECRET must contain at least 32 bytes");
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: hkdfSalt, info: hkdfInfo },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return {
    async encrypt(settingKey: string, plaintext: string): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(settingKey) }, key, encoder.encode(plaintext),
      );
      return `${version}.${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
    },
    async decrypt(settingKey: string, stored: string): Promise<string> {
      const parts = stored.split(".");
      if (parts.length !== 3 || parts[0] !== version) throw new SettingsCryptoError("Unsupported ciphertext");
      try {
        const opened = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: fromBase64url(parts[1]), additionalData: encoder.encode(settingKey) },
          key, fromBase64url(parts[2]),
        );
        return decoder.decode(opened);
      } catch {
        // The platform error says nothing useful and must never carry material into logs.
        throw new SettingsCryptoError("Setting cannot be decrypted");
      }
    },
  };
}

export type SettingsCipher = Awaited<ReturnType<typeof createSettingsCipher>>;
