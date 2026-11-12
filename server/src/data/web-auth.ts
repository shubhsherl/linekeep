import { webCrypto } from "../security/web-crypto";
import { type Clock } from "./values";

export const WEB_SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const WEB_SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
export const LOGIN_RESEND_COOLDOWN_MS = 30 * 1000;
export const LOGIN_REQUESTS_PER_EMAIL_PER_HOUR = 5;
export const LOGIN_REQUESTS_PER_IP_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;
/** A session's last-seen time is rewritten at most this often, so a busy page does not write on every request. */
const TOUCH_INTERVAL_MS = 60 * 1000;

export interface SignInEmployee { id: string; name: string; phoneNumber: string | null }

export interface WebSession {
  id: string;
  employee: SignInEmployee;
  /** When the session ends if it is not used again, or at the 12 hour limit if that comes first. */
  expiresAt: string;
}

export type RateVerdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface LoginCodeAttempt {
  id: string;
  employeeId: string | null;
  codeHash: string;
}

/** Everything the employee web sign-in stores. Secrets (codes, tokens, addresses) go in only as keyed hashes. */
export interface WebAuthRepository {
  /** The active employee who signs in with this (already lower-cased) address. */
  findEmployeeByEmail(email: string): Promise<SignInEmployee | null>;
  /** Counts one request against `key`; refuses once more than `limit` fall inside the hour. */
  hit(key: string, limit: number): Promise<RateVerdict>;
  /** Seconds left of the resend cooldown for `key`, or 0. */
  cooldownSeconds(key: string): Promise<number>;
  /** Replaces the active code for the address. A null `employeeId` stores a decoy that can never be redeemed. */
  storeCode(code: { id: string; emailKey: string; employeeId: string | null; method: "email" | "whatsapp"; codeHash: string }): Promise<void>;
  /** Spends one of the active code's attempts and returns it; null when there is none left, or it expired or was used. */
  takeAttempt(emailKey: string): Promise<LoginCodeAttempt | null>;
  /** Marks the code used. False when somebody else already did. */
  redeemCode(id: string): Promise<boolean>;
  createSession(employeeId: string): Promise<{ token: string; expiresAt: string }>;
  /** The live session for a cookie value, sliding its idle deadline; null when unknown, expired, or the employee or feature is off. */
  authenticate(token: string): Promise<WebSession | null>;
  endSession(token: string): Promise<void>;
  /** Drops expired sessions, codes and counters. */
  purge(): Promise<void>;
}

interface SessionRow {
  id: string; employee_id: string; last_seen_at: string; expires_at: string; idle_expires_at: string;
  name: string; phone_number: string | null;
}

export function createWebAuthRepository(db: D1Database, tokenHashSecret: string | undefined, clock: Clock = () => new Date()): WebAuthRepository {
  const keys = webCrypto(tokenHashSecret);
  const iso = (ms: number) => new Date(ms).toISOString();
  const now = () => clock().getTime();

  return {
    async findEmployeeByEmail(email) {
      const row = await db
        .prepare("SELECT id, name, phone_number FROM employees WHERE lower(email) = ? AND active = 1")
        .bind(email)
        .first<{ id: string; name: string; phone_number: string | null }>();
      return row ? { id: row.id, name: row.name, phoneNumber: row.phone_number } : null;
    },

    async hit(key, limit) {
      const at = now();
      const row = await db.prepare(
        `INSERT INTO web_rate_counters (key, window_start, count, last_at) VALUES (?1, ?2, 1, ?2)
        ON CONFLICT(key) DO UPDATE SET
          count = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END,
          window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END,
          last_at = ?2
        RETURNING count, window_start`,
      ).bind(key, iso(at), iso(at - HOUR_MS)).first<{ count: number; window_start: string }>();
      if (!row || row.count <= limit) return { allowed: true };
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(row.window_start) + HOUR_MS - at) / 1000)),
      };
    },

    async cooldownSeconds(key) {
      const row = await db.prepare("SELECT last_at FROM web_rate_counters WHERE key = ?").bind(key).first<{ last_at: string }>();
      if (!row) return 0;
      return Math.max(0, Math.ceil((Date.parse(row.last_at) + LOGIN_RESEND_COOLDOWN_MS - now()) / 1000));
    },

    async storeCode(code) {
      const at = now();
      await db.batch([
        db.prepare("UPDATE web_login_codes SET used_at = ? WHERE email_key = ? AND used_at IS NULL").bind(iso(at), code.emailKey),
        db.prepare(
          `INSERT INTO web_login_codes (id, email_key, employee_id, method, code_hash, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(code.id, code.emailKey, code.employeeId, code.method, code.codeHash, iso(at), iso(at + LOGIN_CODE_TTL_MS)),
      ]);
    },

    async takeAttempt(emailKey) {
      // One statement picks the newest live code and spends an attempt on it, so parallel guesses cannot
      // exceed the limit.
      const row = await db.prepare(
        `UPDATE web_login_codes SET attempts = attempts + 1
        WHERE id = (SELECT id FROM web_login_codes WHERE email_key = ?1 AND used_at IS NULL AND expires_at > ?2
            AND attempts < ?3 ORDER BY created_at DESC, id DESC LIMIT 1)
          AND used_at IS NULL AND attempts < ?3
        RETURNING id, employee_id, code_hash`,
      ).bind(emailKey, iso(now()), LOGIN_CODE_MAX_ATTEMPTS).first<{ id: string; employee_id: string | null; code_hash: string }>();
      return row ? { id: row.id, employeeId: row.employee_id, codeHash: row.code_hash } : null;
    },

    async redeemCode(id) {
      const row = await db
        .prepare("UPDATE web_login_codes SET used_at = ? WHERE id = ? AND used_at IS NULL RETURNING id")
        .bind(iso(now()), id)
        .first();
      return row !== null;
    },

    async createSession(employeeId) {
      const token = `wst_${keys.token()}`;
      const at = now();
      const expiresAt = iso(at + WEB_SESSION_ABSOLUTE_MS);
      await db.prepare(
        `INSERT INTO web_sessions (id, employee_id, token_hash, created_at, last_seen_at, expires_at, idle_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `wss_${crypto.randomUUID()}`, employeeId, await keys.mac("session", token), iso(at), iso(at), expiresAt,
        iso(at + WEB_SESSION_IDLE_MS),
      ).run();
      return { token, expiresAt: iso(Math.min(at + WEB_SESSION_ABSOLUTE_MS, at + WEB_SESSION_IDLE_MS)) };
    },

    async authenticate(token) {
      const at = now();
      const row = await db.prepare(
        `SELECT s.id, s.employee_id, s.last_seen_at, s.expires_at, s.idle_expires_at, e.name, e.phone_number
        FROM web_sessions s JOIN employees e ON e.id = s.employee_id
        WHERE s.token_hash = ? AND e.active = 1 AND s.expires_at > ? AND s.idle_expires_at > ?
          AND EXISTS (SELECT 1 FROM app_settings a WHERE a.key = 'employeeWeb.enabled' AND a.value = 'true')`,
      ).bind(await keys.mac("session", token), iso(at), iso(at)).first<SessionRow>();
      if (!row) return null;
      let idleExpiresAt = row.idle_expires_at;
      if (at - Date.parse(row.last_seen_at) > TOUCH_INTERVAL_MS) {
        idleExpiresAt = iso(at + WEB_SESSION_IDLE_MS);
        await db.prepare("UPDATE web_sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?")
          .bind(iso(at), idleExpiresAt, row.id).run();
      }
      return {
        id: row.id,
        employee: { id: row.employee_id, name: row.name, phoneNumber: row.phone_number },
        expiresAt: idleExpiresAt < row.expires_at ? idleExpiresAt : row.expires_at,
      };
    },

    async endSession(token) {
      await db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").bind(await keys.mac("session", token)).run();
    },

    async purge() {
      const at = now();
      const day = iso(at - 24 * HOUR_MS);
      await db.batch([
        db.prepare("DELETE FROM web_sessions WHERE expires_at < ? OR idle_expires_at < ?").bind(iso(at), iso(at)),
        db.prepare("DELETE FROM web_login_codes WHERE expires_at < ?").bind(day),
        db.prepare("DELETE FROM web_rate_counters WHERE window_start < ?").bind(day),
      ]);
    },
  };
}
