import { cacheKeyPrefix } from "./fields";
import { canEncrypt, createSettingsCipher, SettingsCryptoError, type SettingsCipher } from "./crypto";

export interface SettingChange {
  key: string;
  /** null deletes the row. */
  value: string | null;
  /** Encrypt the value at rest. */
  secret?: boolean;
}

/** Thrown when a secret must be stored but TOKEN_HASH_SECRET cannot seed the encryption key. */
export class SettingsEncryptionUnavailableError extends Error {
  constructor() {
    super("Saving secrets needs TOKEN_HASH_SECRET (at least 32 bytes) to be set on the server");
  }
}

// One derived key per isolate; the secret is a deployment constant.
let cachedCipher: { secret: string; cipher: Promise<SettingsCipher> } | undefined;
function cipherFor(secret: string): Promise<SettingsCipher> {
  if (cachedCipher?.secret !== secret) {
    const cipher = createSettingsCipher(secret);
    cipher.catch(() => { if (cachedCipher?.cipher === cipher) cachedCipher = undefined; });
    cachedCipher = { secret, cipher };
  }
  return cachedCipher.cipher;
}

interface Row { key: string; value: string; encrypted: number }

/**
 * The `app_settings` table. Reading never throws on a bad row: a secret that cannot be decrypted (key rotated,
 * value moved between keys, tampering) is reported as unreadable and treated as not set.
 */
export function createSettingsStore(db: D1Database, tokenHashSecret: string | undefined, clock: () => Date = () => new Date()) {
  return {
    async readAll(): Promise<{ values: Map<string, string>; unreadable: Set<string> }> {
      const { results } = await db.prepare("SELECT key, value, encrypted FROM app_settings WHERE substr(key, 1, ?) <> ?").bind(cacheKeyPrefix.length, cacheKeyPrefix).all<Row>().catch((error: unknown) => {
        // Code deployed before migration 0017 has run: behave as if nothing is configured in the dashboard yet.
        if (error instanceof Error && /no such table/i.test(error.message)) return { results: [] as Row[] };
        throw error;
      });
      const values = new Map<string, string>();
      const unreadable = new Set<string>();
      const cipher = results.some((row) => row.encrypted === 1) && canEncrypt(tokenHashSecret)
        ? await cipherFor(tokenHashSecret) : null;
      for (const row of results) {
        if (row.encrypted !== 1) {
          values.set(row.key, row.value);
          continue;
        }
        try {
          if (!cipher) throw new SettingsCryptoError("No decryption key");
          values.set(row.key, await cipher.decrypt(row.key, row.value));
        } catch {
          unreadable.add(row.key);
        }
      }
      return { values, unreadable };
    },

    /** Applies all changes in one atomic batch. */
    async write(changes: SettingChange[]): Promise<void> {
      if (changes.length === 0) return;
      const now = clock().toISOString();
      let cipher: SettingsCipher | null = null;
      if (changes.some((change) => change.secret && change.value !== null)) {
        if (!canEncrypt(tokenHashSecret)) throw new SettingsEncryptionUnavailableError();
        cipher = await cipherFor(tokenHashSecret);
      }
      const statements: D1PreparedStatement[] = [];
      for (const change of changes) {
        if (change.value === null) {
          statements.push(db.prepare("DELETE FROM app_settings WHERE key = ?").bind(change.key));
          continue;
        }
        const stored = change.secret ? await cipher!.encrypt(change.key, change.value) : change.value;
        statements.push(db.prepare(
          `INSERT INTO app_settings (key, value, encrypted, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted, updated_at = excluded.updated_at`,
        ).bind(change.key, stored, change.secret ? 1 : 0, now));
      }
      await db.batch(statements);
    },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
