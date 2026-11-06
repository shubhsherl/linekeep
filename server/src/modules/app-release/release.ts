import type { Env } from "../../env";
import { saveSettings } from "../../settings/service";

export const apkContentType = "application/vnd.android.package-archive";
export const objectPrefix = "app-releases/";
export const keepReleases = 3;
export const minApkBytes = 1024;
export const maxApkBytes = 100 * 1024 * 1024;
export const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/;

const latestKey = "app.latest";
const sharingKey = "app.publicDownload";

export interface AppRelease {
  versionName: string;
  size: number;
  /** Lowercase hex SHA-256 of the stored file. */
  sha256: string;
  uploadedAt: string;
  objectKey: string;
}

export const objectKeyFor = (versionName: string) => `${objectPrefix}linekeep-${versionName}.apk`;
export const fileNameFor = (release: AppRelease) => `linekeep-${release.versionName}.apk`;

function parseRelease(raw: string | undefined): AppRelease | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AppRelease>;
    if (
      typeof value.versionName === "string" && versionPattern.test(value.versionName) &&
      typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0 &&
      typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256) &&
      typeof value.uploadedAt === "string" && !Number.isNaN(Date.parse(value.uploadedAt)) &&
      value.objectKey === objectKeyFor(value.versionName)
    ) {
      const { versionName, size, sha256, uploadedAt, objectKey } = value;
      return { versionName, size, sha256, uploadedAt, objectKey };
    }
  } catch { /* corrupt row: treated as no release */ }
  return null;
}

export interface ReleaseState {
  latest: AppRelease | null;
  publicDownload: boolean;
}

/** Read straight from D1, never from the settings cache: switching sharing off must take effect at once. */
export async function readReleaseState(db: D1Database): Promise<ReleaseState> {
  const { results } = await db.prepare("SELECT key, value FROM app_settings WHERE key IN (?, ?)")
    .bind(latestKey, sharingKey).all<{ key: string; value: string }>();
  const values = new Map(results.map((row) => [row.key, row.value]));
  return { latest: parseRelease(values.get(latestKey)), publicDownload: values.get(sharingKey) === "true" };
}

type SettingsEnv = Pick<Env, "DB" | "TOKEN_HASH_SECRET">;

export const saveLatest = (env: SettingsEnv, release: AppRelease) =>
  saveSettings(env, [{ key: latestKey, value: JSON.stringify(release) }]);

export const saveSharing = (env: SettingsEnv, publicDownload: boolean) =>
  saveSettings(env, [{ key: sharingKey, value: publicDownload ? "true" : "false" }]);

export const clearRelease = (env: SettingsEnv) =>
  saveSettings(env, [{ key: latestKey, value: null }, { key: sharingKey, value: null }]);

async function listAll(bucket: R2Bucket): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: objectPrefix, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

/** Keeps the newest `keepReleases` uploads (and always `keepKey`); returns how many objects were deleted. */
export async function pruneReleases(bucket: R2Bucket, keepKey: string): Promise<number> {
  const newestFirst = (await listAll(bucket)).sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());
  const keep = new Set([keepKey, ...newestFirst.map((object) => object.key).filter((key) => key !== keepKey)].slice(0, keepReleases));
  const stale = newestFirst.map((object) => object.key).filter((key) => !keep.has(key));
  if (stale.length) await bucket.delete(stale);
  return stale.length;
}

export async function deleteAllReleases(bucket: R2Bucket): Promise<void> {
  const keys = (await listAll(bucket)).map((object) => object.key);
  for (let index = 0; index < keys.length; index += 1000) await bucket.delete(keys.slice(index, index + 1000));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
