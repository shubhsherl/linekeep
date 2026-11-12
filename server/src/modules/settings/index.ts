import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z, ZodError } from "zod";

import { recordActivity, requestActor } from "../../activity/record";
import type { AppBindings } from "../../app";
import type { Env } from "../../env";
import { ApiError } from "../../http/errors";
import { sendTestEmail } from "../../reporting/call-summary";
import { mailProblems } from "../../reporting/mail";
import { pushAccount } from "../../push/fcm";
import { pushClientConfig } from "../../push/client-config";
import { canEncrypt } from "../../settings/crypto";
import { activityKeys, fieldByKey, featureKeys, MAX_ACTIVITY_RETENTION_DAYS, sections, type Section } from "../../settings/fields";
import { whatsappTemplateSetting } from "../../settings/employee-web";
import { employeeWebChanges, type EmployeeWebInput } from "./employee-web";
import {
  applySettings, describeEmployeeWeb, describeSettings, importableFields, invalidateSettings, loadSettings, resolveFeatures, saveSettings,
  type SettingsSnapshot,
} from "../../settings/service";
import type { SettingChange } from "../../settings/store";
import { MailError } from "../../reporting/mail";
import { checkPhoneNumber, whatsappConfig } from "../../whatsapp/cloud";

const nullable = <T extends z.ZodType>(type: T) => type.nullable().optional();
const text = nullable(z.string().max(12000));

const bodies = {
  features: z.strictObject({ customers: nullable(z.boolean()), whatsapp: nullable(z.boolean()) }),
  whatsapp: z.strictObject({
    token: text, appSecret: text, phoneNumberId: text, wabaId: text, appId: text, graphVersion: text,
    verifyToken: z.union([z.string().max(12000), z.strictObject({ generate: z.literal(true) }), z.null()]).optional(),
  }),
  email: z.strictObject({
    enabled: nullable(z.boolean()), apiKey: text, domain: text, fromEmail: text, region: text, sendTime: text,
    recipients: nullable(z.array(z.string().max(320)).max(1000)),
  }),
  push: z.strictObject({ serviceAccount: text, clientConfig: nullable(z.record(z.string(), z.unknown())) }),
  employeeWeb: z.strictObject({
    enabled: nullable(z.boolean()), emailOtp: nullable(z.boolean()), whatsappOtp: nullable(z.boolean()),
    whatsappTemplate: nullable(whatsappTemplateSetting),
  }),
  activity: z.strictObject({ retentionDays: nullable(z.number().int().min(0).max(MAX_ACTIVITY_RETENTION_DAYS)) }),
} satisfies Record<Section, z.ZodType>;

const hints: Record<string, string> = {
  "whatsapp.token": "paste the permanent access token (no spaces)",
  "whatsapp.appSecret": "paste the app secret from the Meta app settings (no spaces)",
  "whatsapp.verifyToken": "use 8-128 visible characters without spaces",
  "whatsapp.phoneNumberId": "use the digits of the phone number id",
  "whatsapp.wabaId": "use the digits of the WhatsApp Business Account id",
  "whatsapp.appId": "use the digits of the Meta app id",
  "whatsapp.graphVersion": "use a version such as v23.0",
  "email.enabled": "use true or false",
  "email.apiKey": "paste the Mailgun API key (no spaces)",
  "email.domain": "use a domain such as mg.example.com",
  "email.fromEmail": "use a valid email address",
  "email.region": 'use "us" or "eu"',
  "email.recipients": "use valid email addresses",
  "email.sendTime": "use 24-hour India time such as 18:00",
  "push.serviceAccount": "paste the whole service-account JSON file from Firebase (it needs client_email, private_key and project_id)",
  "push.clientConfig": "use apiKey, appId, projectId and senderId from the Firebase Android app",
};

const invalid = (message: string) => new ApiError(400, "INVALID_REQUEST", message);

function parseBody<S extends Section>(section: S, input: unknown): z.infer<(typeof bodies)[S]> {
  try {
    return bodies[section].parse(input) as z.infer<(typeof bodies)[S]>;
  } catch (error) {
    // Zod messages name fields and types, never the submitted values.
    if (error instanceof ZodError) {
      throw invalid(`Invalid ${section} settings: ${error.issues.map((issue) => [...issue.path, issue.message].join(": ")).slice(0, 3).join("; ")}`);
    }
    throw error;
  }
}

/** Raw JSON value to the stored text of an env variable. */
function toText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

const generateVerifyToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, "0")).join("");

const deploymentOf = (context: Context<AppBindings>): Env => context.get("deploymentEnv") ?? context.env;

/** Settings are read fresh here: an administrator editing them must see the truth, not a 15 s old copy. */
async function freshSnapshot(env: Env): Promise<SettingsSnapshot> {
  invalidateSettings(env.DB);
  return loadSettings(env);
}

function view(deployment: Env, snapshot: SettingsSnapshot, only?: Section) {
  const settings = describeSettings(deployment, snapshot);
  return {
    settings: only ? { [only]: settings[only] } : settings,
    deployment: { importable: importableFields(deployment, snapshot).map((field) => field.key) },
  };
}

function requireEncryption(env: Env): void {
  if (!canEncrypt(env.TOKEN_HASH_SECRET)) {
    throw new ApiError(503, "NOT_CONFIGURED", "Saving secrets needs TOKEN_HASH_SECRET (at least 32 bytes) to be set on the server");
  }
}

function projectIdOf(serviceAccount: string | undefined): string | null {
  return pushAccount({ FCM_SERVICE_ACCOUNT: serviceAccount })?.project_id ?? null;
}

/** Mount at /v1/admin; callers must supply the existing administrator guard. */
export function createAdminSettingsRoutes(authorize: MiddlewareHandler<AppBindings>) {
  if (typeof authorize !== "function") throw new TypeError("Admin authorization is required");
  const routes = new Hono<AppBindings>();
  routes.use("/settings", authorize);
  routes.use("/settings/*", authorize);
  routes.use("/features", authorize);

  routes.get("/features", async (context) => {
    const deployment = deploymentOf(context);
    const snapshot = await loadSettings(deployment);
    const { customers, whatsapp } = resolveFeatures(deployment, snapshot);
    const web = describeEmployeeWeb(applySettings(deployment, snapshot), snapshot);
    return context.json({
      requestId: context.get("requestId"), customers, whatsapp,
      employeeWeb: web.active, employeeWebMethods: web.active ? web.methods : [],
    });
  });

  routes.get("/settings", async (context) => {
    const deployment = deploymentOf(context);
    return context.json({ requestId: context.get("requestId"), ...view(deployment, await freshSnapshot(deployment)) });
  });

  routes.post("/settings/import-deployment", async (context) => {
    const deployment = deploymentOf(context);
    const importable = importableFields(deployment, await freshSnapshot(deployment));
    if (importable.some((field) => field.secret)) requireEncryption(deployment);
    await saveSettings(deployment, importable.map((field) => ({ key: field.key, value: field.value, secret: field.secret })));
    await recordActivity(context, { ...requestActor(context), category: "admin", action: "settings_imported", details: { keys: importable.map((field) => field.key) } });
    return context.json({ requestId: context.get("requestId"), imported: importable.map((field) => field.key) });
  });

  routes.post("/settings/whatsapp/test", async (context) => {
    const deployment = deploymentOf(context);
    const env = applySettings(deployment, await freshSnapshot(deployment));
    const config = whatsappConfig(env);
    const result = config
      ? await checkPhoneNumber(config)
      : { ok: false, error: "Save the access token and the phone number id first." };
    return context.json({ requestId: context.get("requestId"), ...result });
  });

  routes.post("/settings/email/test", async (context) => {
    const deployment = deploymentOf(context);
    const env = applySettings(deployment, await freshSnapshot(deployment));
    const problems = mailProblems(env);
    if (problems.length > 0) {
      return context.json({ requestId: context.get("requestId"), ok: false, error: `Email is not set up yet: check the ${problems.join(", ")}.` });
    }
    try {
      await sendTestEmail(env);
      return context.json({ requestId: context.get("requestId"), ok: true });
    } catch (error) {
      const status = error instanceof MailError ? error.status : 0;
      return context.json({
        requestId: context.get("requestId"), ok: false,
        error: status === 0 ? "Could not reach Mailgun. Try again in a moment."
          : status === 401 || status === 403 ? "Mailgun rejected the API key or domain."
            : `Mailgun did not accept the message (HTTP ${status}).`,
      });
    }
  });

  routes.put("/settings/:section", bodyLimit({ maxSize: 16384 }), async (context) => {
    const section = context.req.param("section") as Section;
    if (!sections.includes(section)) throw new ApiError(404, "NOT_FOUND", "Unknown settings section");
    const input = parseBody(section, await context.req.json()) as Record<string, unknown>;
    const deployment = deploymentOf(context);
    const snapshot = await freshSnapshot(deployment);
    const changes: SettingChange[] = [];
    let generatedVerifyToken: string | undefined;

    if (section === "features") {
      const next = { ...Object.fromEntries(Object.entries(featureKeys).map(([name, key]) => [name, snapshot.values.get(key)])) };
      for (const [name, key] of Object.entries(featureKeys)) {
        if (!Object.hasOwn(input, name)) continue;
        const value = input[name] as boolean | null;
        changes.push({ key, value: value === null ? null : String(value) });
        next[name] = value === null ? undefined : String(value);
      }
      const effective = resolveFeatures(deployment, { values: new Map(Object.entries(next).flatMap(([name, value]) =>
        value === undefined ? [] : [[featureKeys[name as keyof typeof featureKeys], value] as const])) });
      if (next.whatsapp === "true" && !effective.customers) throw invalid("Turn on Customers before WhatsApp");
      if (next.customers === "false" && snapshot.values.get(featureKeys.whatsapp) === "true" && !Object.hasOwn(input, "whatsapp")) {
        throw invalid("Turn WhatsApp off before turning Customers off");
      }
      if (next.customers === "false" && next.whatsapp === "true") throw invalid("WhatsApp needs Customers");
    } else if (section === "activity") {
      const days = (input as { retentionDays?: number | null }).retentionDays;
      if (days !== undefined) changes.push({ key: activityKeys.retentionDays, value: days === null ? null : String(days) });
    } else if (section === "employeeWeb") {
      changes.push(...await employeeWebChanges(applySettings(deployment, snapshot), snapshot, input as EmployeeWebInput));
    } else {
      const merged = new Map(snapshot.values);
      for (const [name, value] of Object.entries(input)) {
        if (value === undefined) continue;
        const key = `${section}.${name}`;
        const field = fieldByKey.get(key)!;
        if (value === null) {
          changes.push({ key, value: null });
          merged.delete(key);
          continue;
        }
        if (key === "whatsapp.verifyToken" && typeof value === "object") {
          generatedVerifyToken = generateVerifyToken();
          changes.push({ key, value: generatedVerifyToken, secret: true });
          continue;
        }
        const stored = field.normalize(toText(value));
        if (stored === null) throw invalid(`${key} is not valid: ${hints[key]}`);
        changes.push({ key, value: stored, secret: field.secret });
        merged.set(key, stored);
      }
      if (section === "push") {
        // Phones sign in to one Firebase project; the server must send through the same one.
        const account = projectIdOf(merged.get("push.serviceAccount") ?? deployment.FCM_SERVICE_ACCOUNT?.trim());
        const client = pushClientConfig(merged.get("push.clientConfig") ?? deployment.FIREBASE_CLIENT_CONFIG?.trim());
        if (account && client && account !== client.projectId) {
          throw invalid("push.clientConfig.projectId does not match the service account's project_id");
        }
      }
    }

    if (changes.some((change) => change.secret && change.value !== null)) requireEncryption(deployment);
    await saveSettings(deployment, changes);
    // Which settings changed, never their values.
    if (changes.length > 0) {
      await recordActivity(context, { ...requestActor(context), category: "admin", action: "settings_saved", details: { section, keys: changes.map((change) => change.key) } });
    }
    return context.json({
      requestId: context.get("requestId"),
      ...view(deployment, await freshSnapshot(deployment), section),
      ...(generatedVerifyToken ? { generatedVerifyToken } : {}),
    });
  });

  return routes;
}
