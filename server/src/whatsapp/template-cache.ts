import type { Env } from "../env";
import { cacheKeys } from "../settings/fields";
import { WhatsAppSendError, type WhatsAppConfig } from "./cloud";
import { fetchTemplates, type WhatsAppTemplate } from "./templates";

/** Templates rarely change, so a copy is trusted for a week unless something says otherwise. */
export const TEMPLATE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A template that is not in the cache triggers one refresh, then nothing more for this long (account-wide). */
export const UNKNOWN_TEMPLATE_REFRESH_GAP_MS = 5 * 60 * 1000;
/** Gap enforced between forced refreshes. */
export const FORCED_REFRESH_GAP_MS = 10 * 1000;
/** After a failed attempt, expiry-triggered refreshes wait this long (the stale copy is served meanwhile). */
const FAILED_REFRESH_BACKOFF_MS = 60 * 1000;
/** How long one isolate trusts its in-memory copy before asking D1 again. */
const MEMORY_MS = 60 * 1000;

/** Meta errors on a template send that mean the template we hold is out of date: gone, paused, disabled or changed. */
const TEMPLATE_STALE_ERROR_CODES = new Set([
  132000, // number of parameters does not match
  132001, // template does not exist in this language
  132007, // template content violates policy (disabled)
  132012, // parameter format mismatch
  132015, // template is paused
  132016, // template is disabled
]);

interface Entry {
  wabaId: string; graphVersion: string;
  /** When the templates were last fetched successfully. */
  fetchedAt: string;
  /** When Meta was last asked, successfully or not; spaces out refreshes. */
  attemptedAt: string;
  attemptOk: boolean;
  /** A send showed the list is out of date; it is refreshed on next use. */
  invalid?: boolean;
  templates: WhatsAppTemplate[];
}

export interface TemplateSnapshot {
  templates: WhatsAppTemplate[];
  fetchedAt: string;
  expiresAt: string;
  /** Older than the TTL (or known to be out of date) and served because Meta could not be reached. */
  stale: boolean;
}

/** A forced refresh came less than ten seconds after the previous attempt. */
export class TemplateRefreshTooSoonError extends Error {
  constructor(readonly retryAfterSeconds: number) { super("Templates were refreshed moments ago"); }
}

const clock = () => Date.now();
const memory = new WeakMap<D1Database, { entry: Entry | null; loadedAt: number }>();
const inflight = new WeakMap<D1Database, Promise<Entry>>();

function parseEntry(raw: string): Entry | null {
  try {
    const value = JSON.parse(raw) as Partial<Entry> | null;
    if (!value || typeof value.wabaId !== "string" || typeof value.graphVersion !== "string"
      || typeof value.fetchedAt !== "string" || !Number.isFinite(Date.parse(value.fetchedAt)) || !Array.isArray(value.templates)) return null;
    const attemptedAt = typeof value.attemptedAt === "string" && Number.isFinite(Date.parse(value.attemptedAt)) ? value.attemptedAt : value.fetchedAt;
    return { ...value, attemptedAt, attemptOk: value.attemptOk !== false, templates: value.templates } as Entry;
  } catch {
    return null;
  }
}

async function load(db: D1Database): Promise<Entry | null> {
  const cached = memory.get(db);
  if (cached && clock() - cached.loadedAt < MEMORY_MS) return cached.entry;
  const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(cacheKeys.whatsappTemplates).first<{ value: string }>();
  const entry = row ? parseEntry(row.value) : null;
  memory.set(db, { entry, loadedAt: clock() });
  return entry;
}

async function save(db: D1Database, entry: Entry): Promise<void> {
  await db.prepare(
    `INSERT INTO app_settings (key, value, encrypted, updated_at) VALUES (?, ?, 0, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(cacheKeys.whatsappTemplates, JSON.stringify(entry), new Date(clock()).toISOString()).run();
  memory.set(db, { entry, loadedAt: clock() });
}

const matches = (entry: Entry | null, config: WhatsAppConfig): entry is Entry =>
  entry !== null && entry.wabaId === config.wabaId && entry.graphVersion === config.version;

const isStale = (entry: Entry) => entry.invalid === true || clock() - Date.parse(entry.fetchedAt) >= TEMPLATE_CACHE_TTL_MS;

function snapshot(entry: Entry): TemplateSnapshot {
  return {
    templates: entry.templates, fetchedAt: entry.fetchedAt,
    expiresAt: new Date(Date.parse(entry.fetchedAt) + TEMPLATE_CACHE_TTL_MS).toISOString(), stale: isStale(entry),
  };
}

/** One fetch at a time per isolate: concurrent callers share it. On failure the previous copy is kept, marked as attempted. */
function refresh(db: D1Database, config: WhatsAppConfig, previous: Entry | null): Promise<Entry> {
  const running = inflight.get(db);
  if (running) return running;
  const run = (async () => {
    const attemptedAt = new Date(clock()).toISOString();
    try {
      const templates = await fetchTemplates(config);
      const entry: Entry = { wabaId: config.wabaId!, graphVersion: config.version, fetchedAt: attemptedAt, attemptedAt, attemptOk: true, templates };
      await save(db, entry);
      return entry;
    } catch (error) {
      if (previous) await save(db, { ...previous, attemptedAt, attemptOk: false }).catch(() => undefined);
      throw error;
    }
  })();
  inflight.set(db, run);
  run.finally(() => inflight.delete(db)).catch(() => undefined);
  return run;
}

export interface GetTemplatesOptions {
  /** A template the caller is about to use. If the cache does not know it, Meta is asked once (then not again for five minutes). */
  name?: string;
  language?: string;
  /** Fetch now, whatever the age of the cache. Throws {@link TemplateRefreshTooSoonError} within ten seconds of the last attempt. */
  refresh?: boolean;
}

/**
 * The account's approved templates, from the cache whenever it is trusted: a copy younger than a week for the same business
 * account and Graph version needs no Meta call. A missing or expired copy is refetched (and a stale one is served if that
 * fails). The one thrown failure is a {@link WhatsAppSendError} when there is nothing at all to serve.
 */
export async function getTemplates(env: Pick<Env, "DB">, config: WhatsAppConfig, options: GetTemplatesOptions = {}): Promise<TemplateSnapshot> {
  if (!config.wabaId) throw new WhatsAppSendError(0, null, false);
  const stored = await load(env.DB);
  const entry = matches(stored, config) ? stored : null;
  const sinceAttempt = entry ? clock() - Date.parse(entry.attemptedAt) : Infinity;

  if (options.refresh) {
    if (sinceAttempt < FORCED_REFRESH_GAP_MS) throw new TemplateRefreshTooSoonError(Math.ceil((FORCED_REFRESH_GAP_MS - sinceAttempt) / 1000));
    return snapshot(await refresh(env.DB, config, entry));
  }
  if (!entry) return snapshot(await refresh(env.DB, config, null));
  if (isStale(entry)) {
    if (!entry.attemptOk && sinceAttempt < FAILED_REFRESH_BACKOFF_MS) return snapshot(entry);
    return refresh(env.DB, config, entry).then(snapshot, () => snapshot(entry));
  }
  const unknown = options.name !== undefined
    && !entry.templates.some((item) => item.name === options.name && (options.language === undefined || item.language === options.language));
  if (unknown && sinceAttempt >= UNKNOWN_TEMPLATE_REFRESH_GAP_MS) {
    return refresh(env.DB, config, entry).then(snapshot, () => snapshot(entry));
  }
  return snapshot(entry);
}

/** One template by name and language, going through the cache. Undefined when the account has no such approved template. */
export async function findTemplate(env: Pick<Env, "DB">, config: WhatsAppConfig, name: string, language: string): Promise<WhatsAppTemplate | undefined> {
  return (await getTemplates(env, config, { name, language })).templates.find((item) => item.name === name && item.language === language);
}

/** What is cached for this configuration, without any Meta call. Null when nothing usable is cached. */
export async function peekTemplates(env: Pick<Env, "DB">, config: WhatsAppConfig | null): Promise<TemplateSnapshot | null> {
  const stored = await load(env.DB);
  return config && matches(stored, config) ? snapshot(stored) : null;
}

/** Marks the cached list out of date, so the next use refetches it. Never throws. */
async function invalidate(env: Pick<Env, "DB">): Promise<void> {
  try {
    const entry = await load(env.DB);
    if (entry && !entry.invalid) await save(env.DB, { ...entry, invalid: true });
  } catch {
    // A cache that cannot be marked simply expires on schedule.
  }
}

/** Call with the error of a failed template send: when Meta says the template is gone, paused, disabled or different, the cache is dropped. */
export async function noteTemplateSendFailure(env: Pick<Env, "DB">, error: unknown): Promise<void> {
  if (error instanceof WhatsAppSendError && error.code !== null && TEMPLATE_STALE_ERROR_CODES.has(error.code)) await invalidate(env);
}
