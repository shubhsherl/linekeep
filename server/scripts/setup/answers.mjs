import { DEFAULT_CRON } from "./config.mjs";
import {
  parseBucketName, parseD1Name, parseDays, parseDomain, parseEmail, parseEmailList, parseIstTime,
  parseCredential, parseEnvName, parseMegabytes, parseMetaId, parseRegion, parseSessionDuration, parseTeamName, parseWorkerName,
} from "./validate.mjs";
import {
  parseFirebaseField, parseGoogleServices, parseServiceAccount, PUSH_PREREQUISITES, readFileText, serializeClientConfig,
} from "./push.mjs";
import { WHATSAPP_PREREQUISITES } from "./whatsapp.mjs";

export const FEATURE_OPTIONS = [
  {
    value: "access",
    label: "Admin protection with Cloudflare Access",
    hint: "strongly recommended; without it the admin API returns 401 outside local development",
  },
  { value: "email", label: "Daily email summary (Mailgun)", hint: "needs a Mailgun domain and API key" },
  { value: "retention", label: "Recording retention", hint: "deletes recording audio after N days; call logs are kept" },
  {
    value: "whatsapp",
    label: "WhatsApp Business (send and receive customer messages, templates, auto-replies, media)",
    hint: "needs a Meta Business app and WhatsApp Business Account; prerequisites are listed first",
  },
  {
    value: "push",
    label: "Push notifications to employees' phones (Firebase Cloud Messaging)",
    hint: "needs a Firebase project and a service-account key",
  },
];

export const ALWAYS_ON = "Always on, nothing to configure: customers, call analytics and QR-code device setup.";

export class MissingAnswerError extends Error {}

/**
 * Resolves one value: answers file first, then default under --yes, then an interactive prompt.
 * `parse` returns { ok, value } | { ok, error }.
 */
async function field(ctx, { key, fileValue, def, parse, prompt, explain }) {
  if (fileValue !== undefined && fileValue !== null && fileValue !== "") {
    const r = parse(fileValue);
    if (!r.ok) throw new Error(`Invalid answer "${key}": ${r.error}`);
    return r.value;
  }
  if (ctx.yes) {
    if (def === undefined) throw new MissingAnswerError(`Missing required answer "${key}" (add it to the --answers file).`);
    const r = parse(def);
    if (!r.ok) throw new Error(`Invalid default for "${key}": ${r.error}`);
    return r.value;
  }
  if (explain) ctx.ui.say(explain);
  return ctx.ui.ask(prompt, { default: def, parse });
}

async function flag(ctx, { key, fileValue, def, prompt, explain }) {
  if (typeof fileValue === "boolean") return fileValue;
  if (ctx.yes) return def;
  if (explain) ctx.ui.say(explain);
  return ctx.ui.confirm(prompt, def);
}

export async function chooseFeatures(ctx) {
  const file = ctx.file.features;
  let picked;
  if (file !== undefined) {
    if (!Array.isArray(file) || file.some((v) => !FEATURE_OPTIONS.some((o) => o.value === v))) {
      throw new Error(`Invalid answer "features": expected an array of ${FEATURE_OPTIONS.map((o) => o.value).join(", ")}.`);
    }
    picked = file;
  } else if (ctx.yes) {
    picked = ["access"];
  } else {
    ctx.ui.say("");
    ctx.ui.say(ALWAYS_ON);
    picked = await ctx.ui.multiselect("Which optional features do you want?", FEATURE_OPTIONS, ["access"]);
  }
  return Object.fromEntries(FEATURE_OPTIONS.map((o) => [o.value, picked.includes(o.value)]));
}

/** "Set up X now?": the answers file decides under --yes (an explicit `setup` boolean, else yes because the feature was selected there). */
async function proceed(ctx, { fileValue, prompt }) {
  if (typeof fileValue === "boolean") return fileValue;
  if (ctx.yes) return true;
  return ctx.ui.confirm(prompt, false);
}

const SECRET_KEYS = {
  whatsapp: ["token", "accessToken", "appSecret", "verifyToken"],
  push: ["serviceAccount", "serviceAccountJson", "privateKey", "private_key"],
};

/** Throws when the answers file holds a secret value. Secrets come from environment variables, hidden prompts or key files. */
export function assertNoSecretsInAnswers(file) {
  for (const key of ["whatsappToken", "whatsappAppSecret", "whatsappVerifyToken", "fcmServiceAccount"]) {
    if (key in file) throw new Error(`Refusing "${key}" in the answers file: secrets are never read from it. Use the WHATSAPP_TOKEN / WHATSAPP_APP_SECRET environment variables, hidden prompts, or a key-file path.`);
  }
  for (const [section, keys] of Object.entries(SECRET_KEYS)) {
    const value = file[section];
    if (value === undefined || value === null) continue;
    if (typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid answer "${section}": expected an object.`);
    for (const key of keys) {
      if (key in value) {
        const hint = section === "whatsapp"
          ? "Set WHATSAPP_TOKEN / WHATSAPP_APP_SECRET in the environment or answer the hidden prompts; the webhook verify token is generated for you."
          : 'Give the path of the key file instead: "push.serviceAccountFile".';
        throw new Error(`Refusing "${section}.${key}" in the answers file: secrets are never read from it. ${hint}`);
      }
    }
  }
}

/**
 * organization: undefined (unknown, dry run) | null (Zero Trust not enabled) | { auth_domain }.
 * Returns { answers, secrets }. `secrets` holds values that must never be logged or written.
 */
export async function collectAnswers(ctx, features, { organization } = {}) {
  const file = ctx.file;
  const env = await field(ctx, {
    key: "env",
    fileValue: ctx.envFlag ?? file.env,
    def: "production",
    parse: parseEnvName,
    prompt: "Environment name",
    explain: "\nEnvironment: use `production` for real data or `dev` for a trial. It selects the wrangler --env and isolates resources.",
  });
  const workerName = await field(ctx, {
    key: "workerName", fileValue: file.workerName, def: `linekeep-api-${env}`, parse: parseWorkerName, prompt: "Worker name",
    explain: "\nThe Worker name becomes part of your URL: https://<name>.<subdomain>.workers.dev",
  });
  const d1Name = await field(ctx, { key: "d1Name", fileValue: file.d1Name, def: `linekeep-${env}`, parse: parseD1Name, prompt: "D1 database name" });
  const r2Name = await field(ctx, {
    key: "r2Name", fileValue: file.r2Name, def: `linekeep-recordings-${env}`, parse: parseBucketName, prompt: "Private R2 bucket name",
  });
  const maxRecordingMb = await field(ctx, {
    key: "maxRecordingMb", fileValue: file.maxRecordingMb, def: 100, parse: parseMegabytes, prompt: "Maximum recording size in MB",
    explain: "\nUploads larger than this are rejected. Cloudflare request bodies are limited to 100 MB on the Free plan.",
  });

  const answers = { env, workerName, d1Name, r2Name, maxRecordingMb, features, subdomain: file.subdomain ?? null };
  const secrets = {};

  if (features.access) {
    const a = file.access ?? {};
    const emails = await field(ctx, {
      key: "access.emails", fileValue: a.emails, parse: parseEmailList, prompt: "Admin email addresses (comma separated)",
      explain: "\nCloudflare Access: only these addresses will be allowed to open /admin.",
    });
    const sessionDuration = await field(ctx, {
      key: "access.sessionDuration", fileValue: a.sessionDuration, def: "1h", parse: parseSessionDuration, prompt: "Access session duration",
    });
    const oneTimePin = await flag(ctx, {
      key: "access.oneTimePin", fileValue: a.oneTimePin, def: true, prompt: "Enable the One-time PIN login method?",
      explain: "\nOne-time PIN emails a code to the allowed addresses. Without it, only users who sign in through a login method you\nconfigured yourself (for example a Google or Cloudflare account) can get in.",
    });
    let teamName = null;
    let createOrganization = false;
    if (organization === null) {
      teamName = await field(ctx, {
        key: "access.teamName", fileValue: a.teamName, parse: parseTeamName, prompt: "Zero Trust team name",
        explain: "\nThis account has no Zero Trust (Access) organization yet. Its team name becomes <name>.cloudflareaccess.com.",
      });
      createOrganization = await flag(ctx, {
        key: "access.createOrganization", fileValue: a.createOrganization, def: false,
        prompt: `Create the Zero Trust organization "${teamName}.cloudflareaccess.com" now?`,
      });
      if (!createOrganization) {
        throw new Error(
          "Zero Trust is not enabled for this account and creation was declined.\n" +
            "Enable it once in the dashboard (https://one.dash.cloudflare.com, pick the free plan), then re-run setup.\n" +
            "Add \"createOrganization\": true under \"access\" in --answers to allow automatic creation.",
        );
      }
    } else if (organization === undefined) {
      teamName = a.teamName ?? null; // unknown until a real run
      createOrganization = a.createOrganization === true;
    }
    answers.access = { emails, sessionDuration, oneTimePin, teamName, createOrganization };
  }

  if (features.email) {
    const m = file.email ?? {};
    if (typeof m.apiKey === "string") {
      throw new Error('Refusing to read the Mailgun API key from the answers file. Set the MAILGUN_API_KEY environment variable or answer the hidden prompt.');
    }
    const domain = await field(ctx, {
      key: "email.domain", fileValue: m.domain, parse: parseDomain, prompt: "Mailgun sending domain",
      explain: "\nDaily email summary via Mailgun. Use your verified Mailgun sending domain and its matching API key.",
    });
    const region = await field(ctx, { key: "email.region", fileValue: m.region, def: "us", parse: parseRegion, prompt: "Mailgun region (us/eu)" });
    const sender = await field(ctx, { key: "email.from", fileValue: m.from, def: `postmaster@${domain}`, parse: parseEmail, prompt: "Sender address" });
    const recipients = await field(ctx, {
      key: "email.recipients", fileValue: m.recipients, parse: parseEmailList, prompt: "Summary recipients (comma separated)",
      explain: "\nRecipients appear together in the To field and can see each other's addresses.",
    });
    const timeIst = await field(ctx, {
      key: "email.timeIst", fileValue: m.timeIst, def: "18:00", parse: parseIstTime,
      prompt: "Send time in IST (24h HH:MM)",
      explain: "\nThe Worker checks every 30 minutes and sends at the half hour this time falls in (18:10 sends at 18:00). You can change it later in the dashboard's Config.",
    });
    answers.email = {
      domain, region, timeIst, recipients,
      from: sender === `postmaster@${domain}` ? null : sender,
    };
    if (!ctx.dryRun) {
      const fromEnv = ctx.env.MAILGUN_API_KEY?.trim();
      if (fromEnv) secrets.mailgunApiKey = fromEnv;
      else if (ctx.yes) throw new MissingAnswerError("Set the MAILGUN_API_KEY environment variable (it is never read from the answers file).");
      else {
        secrets.mailgunApiKey = await ctx.ui.hidden("Mailgun API key (input hidden)", {
          parse: (v) => (v.length >= 8 ? { ok: true, value: v } : { ok: false, error: "That key looks too short." }),
        });
      }
    }
  }

  if (features.retention) {
    const days = await field(ctx, {
      key: "retention.days", fileValue: file.retention?.days, def: 30, parse: parseDays, prompt: "Delete recordings older than how many days",
      explain: `\nRetention deletes recording AUDIO only (from R2). Call logs, customers and chats are kept. It runs once a day from the Worker's cron (${DEFAULT_CRON}).`,
    });
    answers.retention = { days };
  }

  const maskOnly = [];
  if (features.whatsapp) await collectWhatsApp(ctx, answers, secrets);
  if (features.push) await collectPush(ctx, answers, secrets, maskOnly);
  return { answers, secrets, maskOnly };
}

/** Env var first, then (interactive only) a hidden prompt. Never the answers file. Skipped in dry runs. */
async function secretValue(ctx, { envName, label, parse }) {
  const fromEnv = ctx.env[envName]?.trim();
  if (fromEnv) {
    const r = parse(fromEnv);
    if (!r.ok) throw new Error(`${envName} is set but invalid: ${r.error}`);
    return r.value;
  }
  if (ctx.yes) throw new MissingAnswerError(`Set the ${envName} environment variable (it is never read from the answers file).`);
  return ctx.ui.hidden(`${label} (input hidden)`, { parse });
}

async function collectWhatsApp(ctx, answers, secrets) {
  const w = ctx.file.whatsapp ?? {};
  ctx.ui.say("");
  for (const line of WHATSAPP_PREREQUISITES) ctx.ui.say(line);
  ctx.ui.say("");
  if (!(await proceed(ctx, { fileValue: w.setup, prompt: "Set up WhatsApp now?" }))) {
    answers.features = { ...answers.features, whatsapp: false };
    ctx.ui.say("[..] Skipping WhatsApp. Run setup again later to add it; nothing else is affected.");
    return;
  }
  if (!ctx.dryRun) {
    secrets.whatsappToken = await secretValue(ctx, {
      envName: "WHATSAPP_TOKEN", label: "WhatsApp system user access token",
      parse: (v) => parseCredential(v, "access token"),
    });
  }
  const phoneNumberId = await field(ctx, {
    key: "whatsapp.phoneNumberId", fileValue: w.phoneNumberId, parse: (v) => parseMetaId(v, "Phone number ID"), prompt: "WhatsApp Phone number ID",
    explain: "\nFrom the Meta app: WhatsApp -> API Setup (a numeric ID, not the phone number itself).",
  });
  const wabaId = await field(ctx, {
    key: "whatsapp.wabaId", fileValue: w.wabaId, parse: (v) => parseMetaId(v, "WhatsApp Business Account ID"), prompt: "WhatsApp Business Account (WABA) ID",
  });
  const appId = await field(ctx, {
    key: "whatsapp.appId", fileValue: w.appId, parse: (v) => parseMetaId(v, "App ID"), prompt: "Meta App ID",
    explain: "\nApp ID and App secret: Meta app dashboard -> App settings -> Basic.",
  });
  if (!ctx.dryRun) {
    secrets.whatsappAppSecret = await secretValue(ctx, {
      envName: "WHATSAPP_APP_SECRET", label: "Meta App secret",
      parse: (v) => parseCredential(v, "app secret"),
    });
  }
  for (const key of ["registerWebhook", "replaceVerifyToken"]) {
    if (w[key] !== undefined && typeof w[key] !== "boolean") throw new Error(`Invalid answer "whatsapp.${key}": expected true or false.`);
  }
  answers.whatsapp = {
    phoneNumberId, wabaId, appId,
    registerWebhook: typeof w.registerWebhook === "boolean" ? w.registerWebhook : null,
    replaceVerifyToken: typeof w.replaceVerifyToken === "boolean" ? w.replaceVerifyToken : null,
  };
  ctx.ui.say("\nThe webhook verify token is generated by setup and stored only as a Worker secret; you never type or see it.");
}

async function collectPush(ctx, answers, secrets, maskOnly) {
  const p = ctx.file.push ?? {};
  const home = ctx.env.HOME;
  ctx.ui.say("");
  for (const line of PUSH_PREREQUISITES) ctx.ui.say(line);
  ctx.ui.say("");
  if (!(await proceed(ctx, { fileValue: p.setup, prompt: "Set up push notifications now?" }))) {
    answers.features = { ...answers.features, push: false };
    ctx.ui.say("[..] Skipping push notifications. Run setup again later to add them.");
    return;
  }
  const fileParser = (parse) => (path) => {
    const read = readFileText(ctx.fs, path, home);
    return read.ok ? parse(read.value) : read;
  };
  const account = await field(ctx, {
    key: "push.serviceAccountFile", fileValue: p.serviceAccountFile, parse: fileParser(parseServiceAccount),
    prompt: "Path to the service-account JSON key file",
    explain: "\nThe file is read here and stored as the Worker secret FCM_SERVICE_ACCOUNT. Its contents are never printed.",
  });

  const manual = ["apiKey", "appId", "projectId", "senderId"];
  let client;
  if (typeof p.googleServicesFile === "string" && p.googleServicesFile !== "") {
    client = await field(ctx, { key: "push.googleServicesFile", fileValue: p.googleServicesFile, parse: fileParser(parseGoogleServices), prompt: "" });
  } else if (manual.some((k) => p[k] !== undefined) || ctx.yes) {
    if (ctx.yes && !manual.every((k) => p[k] !== undefined && p[k] !== "")) {
      throw new MissingAnswerError('Missing required answer "push.googleServicesFile" (or all of push.apiKey, push.appId, push.projectId, push.senderId).');
    }
    const values = {};
    for (const k of manual) {
      values[k] = await field(ctx, { key: `push.${k}`, fileValue: p[k], parse: (v) => parseFirebaseField(k, v), prompt: `Firebase ${k}` });
    }
    client = values;
  } else {
    ctx.ui.say("\nThe phones need four public Firebase identifiers. Easiest: give the path of google-services.json.");
    const path = await ctx.ui.ask("Path to google-services.json (empty to type the four values instead)", {
      default: "", parse: (v) => (v === "" ? { ok: true, value: "" } : fileParser(parseGoogleServices)(v)),
    });
    if (path !== "") client = path;
    else {
      const values = {};
      for (const k of manual) values[k] = await ctx.ui.ask(`Firebase ${k}`, { parse: (v) => parseFirebaseField(k, v) });
      client = values;
    }
  }
  if (client.projectId !== account.projectId) {
    throw new Error(`The service account belongs to Firebase project "${account.projectId}" but the client configuration is for "${client.projectId}". Use files from the same Firebase project.`);
  }
  secrets.fcmServiceAccount = account.json;
  secrets.firebaseClientConfig = serializeClientConfig(client);
  maskOnly.push(account.privateKey); // values appearing inside the JSON in another form (real newlines) must be masked too
  answers.push = { projectId: client.projectId };
}
