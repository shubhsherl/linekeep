import { createActivityRepository } from "../data/activity";
import type { Env } from "../env";
import { activityKeys, activityRetentionDays } from "../settings/fields";

/**
 * Deletes activity log rows older than the configured retention (`activity.retentionDays`, default 90, 0 keeps
 * everything). The setting is read straight from the database, bypassing the settings cache. Returns how many rows
 * were removed.
 */
export async function purgeExpiredActivity(env: Pick<Env, "DB">, now: Date = new Date()): Promise<number> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(activityKeys.retentionDays).first<{ value: string }>();
  const days = activityRetentionDays(new Map(row ? [[activityKeys.retentionDays, row.value]] : []));
  return days > 0 ? createActivityRepository(env.DB).purgeOlderThan(days, now) : 0;
}
