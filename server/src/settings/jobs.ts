import type { Env } from "../env";
import { invalidateSettings } from "./service";

/** Reads a job's run-state (written by `writeJob`) straight from the database, bypassing the settings cache. */
export async function readJob<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function writeJob(env: Pick<Env, "DB">, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, encrypted, updated_at) VALUES (?, ?, 0, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(key, JSON.stringify(value), new Date().toISOString()).run();
  invalidateSettings(env.DB);
}
