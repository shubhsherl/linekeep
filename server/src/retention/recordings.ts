import type { Env } from "../env";

const day = 24 * 60 * 60 * 1000;
// D1 allows 100 bound parameters per statement; the free plan allows few subrequests per invocation
// (each loop below makes three). The cap leaves a backlog for the next daily run instead of failing.
const defaultBatchSize = 50;
const defaultMaxBatches = 15;

/** Unset, non-numeric or < 1 disables the job: deleting data must be an explicit choice. */
export function retentionDays(env: Pick<Env, "RECORDING_RETENTION_DAYS">): number | null {
  const raw = env.RECORDING_RETENTION_DAYS?.trim();
  if (!raw || !/^\d{1,4}$/.test(raw)) return null;
  const days = Number(raw);
  return days >= 1 ? days : null;
}

export type RecordingRetentionResult =
  | { status: "disabled" }
  | { status: "done"; cutoff: string; expired: number; deleted: number; remaining: boolean; dryRun: boolean };

/**
 * Deletes recording audio older than the retention period and tombstones its row, exactly like the admin
 * "Delete recording" action (audio gone, call kept as `deleted`). Age is the call's recorded time, falling
 * back to receipt time. Call logs are not touched.
 */
export async function purgeExpiredRecordings(
  env: Pick<Env, "DB" | "RECORDINGS" | "RECORDING_RETENTION_DAYS">,
  options: { now?: number; dryRun?: boolean; batchSize?: number; maxBatches?: number } = {},
): Promise<RecordingRetentionResult> {
  const days = retentionDays(env);
  if (days === null) return { status: "disabled" };
  const cutoff = new Date((options.now ?? Date.now()) - days * day).toISOString();
  const batchSize = options.batchSize ?? defaultBatchSize;
  const maxBatches = options.maxBatches ?? defaultMaxBatches;
  const dryRun = options.dryRun === true;
  const expiredCondition = "upload_status = 'complete' AND COALESCE(recorded_at, created_at) < ?";

  if (dryRun) {
    const row = await env.DB.prepare(`SELECT count(*) AS n FROM calls WHERE ${expiredCondition}`)
      .bind(cutoff).first<{ n: number }>();
    return { status: "done", cutoff, expired: row?.n ?? 0, deleted: 0, remaining: (row?.n ?? 0) > 0, dryRun };
  }

  let deleted = 0;
  let remaining = false;
  for (let batch = 0; batch < maxBatches; batch++) {
    const { results } = await env.DB.prepare(
      `SELECT id, object_key FROM calls WHERE ${expiredCondition} ORDER BY COALESCE(recorded_at, created_at) LIMIT ?`,
    ).bind(cutoff, batchSize).all<{ id: string; object_key: string }>();
    if (results.length === 0) break;
    // R2 first: a failure leaves the rows complete so the next run retries. Deleting a missing key succeeds.
    await env.RECORDINGS.delete(results.map((row) => row.object_key));
    const marks = results.map(() => "?").join(",");
    await env.DB.prepare(
      `UPDATE calls SET upload_status = 'deleted', deleted_at = COALESCE(deleted_at, ?)
       WHERE upload_status = 'complete' AND id IN (${marks})`,
    ).bind(new Date().toISOString(), ...results.map((row) => row.id)).run();
    deleted += results.length;
    remaining = results.length === batchSize && batch === maxBatches - 1;
  }
  return { status: "done", cutoff, expired: deleted, deleted, remaining, dryRun };
}
