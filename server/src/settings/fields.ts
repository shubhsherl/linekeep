import { z } from "zod";

import type { Env } from "../env";
import { firebaseClientConfig } from "../push/client-config";
import { pushAccount } from "../push/fcm";

export const sections = ["features", "whatsapp", "email", "push", "employeeWeb"] as const;
export type Section = (typeof sections)[number];

/** A dashboard-managed value. `env` is the deployment variable it overrides; stored text always has the env's own format. */
export interface Field {
  readonly key: string;
  readonly section: Exclude<Section, "features" | "employeeWeb">;
  readonly name: string;
  readonly env: keyof Env;
  readonly secret: boolean;
  /** Canonical stored text, or null when the text is not acceptable. */
  readonly normalize: (raw: string) => string | null;
}

const text = (pattern: RegExp, max: number) => (raw: string): string | null => {
  const value = raw.trim();
  return value.length > 0 && value.length <= max && pattern.test(value) ? value : null;
};
const secretText = (min: number, max: number) => (raw: string): string | null => {
  const value = raw.trim();
  return value.length >= min && value.length <= max && /^[\x21-\x7e]+$/.test(value) ? value : null;
};
const metaId = text(/^\d{5,32}$/, 32);
const emailAddress = z.email().max(254);
const domainName = text(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/, 253);

/** The recipient list as env text (JSON array or comma separated) to an array, or null when any entry is not an email. */
export function parseRecipients(raw: string | undefined): string[] | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  try {
    const list = z.array(emailAddress).min(1).max(1000).parse(
      value.startsWith("[") ? JSON.parse(value) : value.split(",").map((entry) => entry.trim()),
    );
    return [...new Set(list)];
  } catch {
    return null;
  }
}

const specs: Omit<Field, "key">[] = [
  { section: "whatsapp", name: "token", env: "WHATSAPP_TOKEN", secret: true, normalize: secretText(8, 4096) },
  { section: "whatsapp", name: "appSecret", env: "WHATSAPP_APP_SECRET", secret: true, normalize: secretText(8, 256) },
  { section: "whatsapp", name: "verifyToken", env: "WHATSAPP_VERIFY_TOKEN", secret: true, normalize: secretText(8, 128) },
  { section: "whatsapp", name: "phoneNumberId", env: "WHATSAPP_PHONE_NUMBER_ID", secret: false, normalize: metaId },
  { section: "whatsapp", name: "wabaId", env: "WHATSAPP_WABA_ID", secret: false, normalize: metaId },
  { section: "whatsapp", name: "appId", env: "WHATSAPP_APP_ID", secret: false, normalize: metaId },
  { section: "whatsapp", name: "graphVersion", env: "WHATSAPP_GRAPH_VERSION", secret: false, normalize: text(/^v\d+\.\d+$/, 12) },
  { section: "email", name: "enabled", env: "CALL_SUMMARY_ENABLED", secret: false, normalize: (raw) => raw === "true" || raw === "false" ? raw : null },
  { section: "email", name: "apiKey", env: "MAILGUN_API_KEY", secret: true, normalize: secretText(8, 512) },
  { section: "email", name: "domain", env: "MAILGUN_DOMAIN", secret: false, normalize: domainName },
  { section: "email", name: "fromEmail", env: "MAILGUN_FROM_EMAIL", secret: false, normalize: (raw) => emailAddress.safeParse(raw.trim()).success ? raw.trim() : null },
  { section: "email", name: "region", env: "MAILGUN_REGION", secret: false, normalize: (raw) => raw === "us" || raw === "eu" ? raw : null },
  { section: "email", name: "recipients", env: "EMAIL_IDS", secret: false, normalize: (raw) => { const list = parseRecipients(raw); return list ? JSON.stringify(list) : null; } },
  { section: "email", name: "sendTime", env: "CALL_SUMMARY_SEND_TIME", secret: false, normalize: text(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 5) },
  { section: "push", name: "serviceAccount", env: "FCM_SERVICE_ACCOUNT", secret: true, normalize: (raw) => {
    const value = raw.trim();
    return value.length <= 12000 && pushAccount({ FCM_SERVICE_ACCOUNT: value }) ? value : null;
  } },
  { section: "push", name: "clientConfig", env: "FIREBASE_CLIENT_CONFIG", secret: false, normalize: (raw) => {
    try {
      const parsed = firebaseClientConfig.safeParse(JSON.parse(raw));
      return parsed.success ? JSON.stringify(parsed.data) : null;
    } catch {
      return null;
    }
  } },
];
const definitions: Field[] = specs.map((spec) => ({ ...spec, key: `${spec.section}.${spec.name}` }));

export const fields: readonly Field[] = definitions;
export const fieldByKey: ReadonlyMap<string, Field> = new Map(definitions.map((field) => [field.key, field]));

export const featureKeys = { customers: "feature.customers", whatsapp: "feature.whatsapp" } as const;
export type FeatureName = keyof typeof featureKeys;
export interface Features { customers: boolean; whatsapp: boolean }

/** Run-state written by scheduled jobs; plain text, not user-editable. */
export const jobKeys = {
  emailLastSent: "job.email.lastSent", retentionLastRun: "job.retention.lastRun", attachmentsLastRun: "job.whatsappAttachments.lastRun",
} as const;

/**
 * Server-side caches kept in `app_settings`. They are not settings: the store never loads them into the settings snapshot
 * (so they cost nothing on ordinary requests), no endpoint lists them and no settings route can write them.
 */
export const cacheKeyPrefix = "cache.";
export const cacheKeys = { whatsappTemplates: "cache.whatsappTemplates" } as const;
