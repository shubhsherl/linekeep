import type { Env } from "../env";
import { pushClientConfig, type FirebaseClientConfig } from "../push/client-config";
import { pushAccount } from "../push/fcm";
import { activityRetentionDays, fieldByKey, featureKeys, fields, jobKeys, parseRecipients, type Features } from "./fields";
import { emailOtpReady, readEmployeeWeb, usableMethods, whatsappOtpReady, whatsappProblems } from "./employee-web";
import { mailTransportProblems } from "../reporting/mail";
import { createSettingsStore, type SettingChange } from "./store";

export interface SettingsSnapshot {
  /** Decrypted database values by key. */
  values: ReadonlyMap<string, string>;
}

const ttlMs = 15_000;
// Per isolate. Writes through this module drop the entry, so the isolate that handled a write sees it at once;
// other isolates catch up within the TTL.
const cache = new WeakMap<D1Database, { expires: number; snapshot: Promise<SettingsSnapshot> }>();

export function invalidateSettings(db: D1Database): void {
  cache.delete(db);
}

/** The database settings, from a ~15 s per-isolate cache. A failed load is not cached. */
export function loadSettings(env: Pick<Env, "DB" | "TOKEN_HASH_SECRET">): Promise<SettingsSnapshot> {
  const hit = cache.get(env.DB);
  if (hit && hit.expires > Date.now()) return hit.snapshot;
  const snapshot = createSettingsStore(env.DB, env.TOKEN_HASH_SECRET).readAll();
  const entry = { expires: Date.now() + ttlMs, snapshot };
  cache.set(env.DB, entry);
  snapshot.catch(() => { if (cache.get(env.DB) === entry) cache.delete(env.DB); });
  return snapshot;
}

/** Saves changes and drops the cached snapshot. */
export async function saveSettings(env: Pick<Env, "DB" | "TOKEN_HASH_SECRET">, changes: SettingChange[]): Promise<void> {
  try {
    await createSettingsStore(env.DB, env.TOKEN_HASH_SECRET).write(changes);
  } finally {
    invalidateSettings(env.DB);
  }
}

/** The deployment env with every database value laid over its variable: database first, then env. */
export function applySettings(env: Env, snapshot: SettingsSnapshot): Env {
  const overlay: Record<string, string> = {};
  for (const field of fields) {
    const value = snapshot.values.get(field.key);
    if (value !== undefined) overlay[field.env] = value;
  }
  return Object.keys(overlay).length === 0 ? env : { ...env, ...overlay };
}

const flag = (snapshot: SettingsSnapshot, key: string): boolean | undefined => {
  const value = snapshot.values.get(key);
  return value === "true" ? true : value === "false" ? false : undefined;
};

/**
 * Feature switches. A missing switch is off, except that an install already configured through WhatsApp
 * variables keeps working until someone turns it off. WhatsApp needs Customers.
 */
export function resolveFeatures(deployment: Env, snapshot: SettingsSnapshot): Features {
  const implied = Boolean(deployment.WHATSAPP_TOKEN?.trim() && deployment.WHATSAPP_PHONE_NUMBER_ID?.trim());
  const customers = flag(snapshot, featureKeys.customers) ?? implied;
  const whatsapp = flag(snapshot, featureKeys.whatsapp) ?? implied;
  return { customers, whatsapp: customers && whatsapp };
}

export type Source = "database" | "deployment" | "none";

function lookup(deployment: Env, snapshot: SettingsSnapshot, key: string): { value: string | undefined; source: Source } {
  const stored = snapshot.values.get(key);
  if (stored !== undefined) return { value: stored, source: "database" };
  const field = fieldByKey.get(key)!;
  const fromEnv = (deployment[field.env] as string | undefined)?.trim();
  return fromEnv ? { value: fromEnv, source: "deployment" } : { value: undefined, source: "none" };
}

/** First and last three characters so an admin can recognise a value; values under 16 characters reveal nothing. */
export function maskSecret(value: string | undefined): string | null {
  const text = value?.trim();
  return text && text.length >= 16 ? `${text.slice(0, 3)}••••${text.slice(-3)}` : null;
}

const secretState = (deployment: Env, snapshot: SettingsSnapshot, key: string, withHint = true) => {
  const { source, value } = lookup(deployment, snapshot, key);
  return { set: source !== "none", source, hint: withHint ? maskSecret(value) : null };
};

function readJson<T>(raw: string | undefined): T | null {
  try { return raw ? JSON.parse(raw) as T : null; } catch { return null; }
}

export interface LastSent { date: string; status: "sent" | "failed" }

export function lastSent(snapshot: SettingsSnapshot): LastSent | null {
  const parsed = readJson<Partial<LastSent>>(snapshot.values.get(jobKeys.emailLastSent));
  return parsed && typeof parsed.date === "string" && (parsed.status === "sent" || parsed.status === "failed")
    ? { date: parsed.date, status: parsed.status } : null;
}

/** What the dashboard sees. Secrets appear only as {set, source}. */
export function describeSettings(deployment: Env, snapshot: SettingsSnapshot) {
  const text = (key: string) => lookup(deployment, snapshot, key).value ?? null;
  const account = lookup(deployment, snapshot, "push.serviceAccount");
  const projectId = pushAccount({ FCM_SERVICE_ACCOUNT: account.value })?.project_id ?? null;
  const clientConfig: FirebaseClientConfig | null = pushClientConfig(lookup(deployment, snapshot, "push.clientConfig").value);
  const enabled = lookup(deployment, snapshot, "email.enabled").value;
  return {
    features: resolveFeatures(deployment, snapshot),
    whatsapp: {
      phoneNumberId: text("whatsapp.phoneNumberId"),
      wabaId: text("whatsapp.wabaId"),
      appId: text("whatsapp.appId"),
      graphVersion: text("whatsapp.graphVersion") ?? "v23.0",
      token: secretState(deployment, snapshot, "whatsapp.token"),
      appSecret: secretState(deployment, snapshot, "whatsapp.appSecret"),
      verifyToken: secretState(deployment, snapshot, "whatsapp.verifyToken"),
    },
    email: {
      enabled: enabled === "true",
      domain: text("email.domain"),
      fromEmail: text("email.fromEmail"),
      region: text("email.region") ?? "us",
      recipients: parseRecipients(lookup(deployment, snapshot, "email.recipients").value) ?? [],
      sendTime: text("email.sendTime") ?? "18:00",
      apiKey: secretState(deployment, snapshot, "email.apiKey"),
      lastSent: lastSent(snapshot),
    },
    push: {
      clientConfig,
      serviceAccount: { ...secretState(deployment, snapshot, "push.serviceAccount", false), projectId },
    },
    employeeWeb: describeEmployeeWeb(applySettings(deployment, snapshot), snapshot),
    activity: { retentionDays: activityRetentionDays(snapshot.values) },
  };
}

/**
 * The employee web app's settings plus what is still missing for each sign-in method, so the dashboard can say
 * what to set up first. `env` is the deployment with the dashboard values laid over it.
 */
export function describeEmployeeWeb(env: Env, snapshot: SettingsSnapshot) {
  const settings = readEmployeeWeb(snapshot.values);
  const methods = usableMethods(env, settings);
  const whatsappMissing = whatsappProblems(env, settings.whatsappTemplate);
  return {
    ...settings,
    /** Sign-in methods that can deliver a code right now (switched on and their prerequisites met). */
    methods,
    usable: { email: methods.includes("email"), whatsapp: methods.includes("whatsapp") },
    /** Whether employees can sign in: the master switch is on and at least one method is usable. */
    active: settings.enabled && methods.length > 0,
    prerequisites: {
      email: { configured: emailOtpReady(env), missing: mailTransportProblems(env) },
      whatsapp: {
        configured: whatsappMissing.length === 0, sending: whatsappOtpReady(env),
        templateChosen: settings.whatsappTemplate !== null, missing: whatsappMissing,
      },
    },
  };
}

/** Dotted names of valid deployment values that are not yet in the database. */
export function importableFields(deployment: Env, snapshot: SettingsSnapshot): { key: string; value: string; secret: boolean }[] {
  const found: { key: string; value: string; secret: boolean }[] = [];
  for (const field of fields) {
    if (snapshot.values.has(field.key)) continue;
    const raw = (deployment[field.env] as string | undefined)?.trim();
    // A disabled switch carries nothing worth copying.
    if (!raw || (field.key === "email.enabled" && raw !== "true")) continue;
    const value = field.normalize(raw);
    if (value !== null) found.push({ key: field.key, value, secret: field.secret });
  }
  return found;
}
