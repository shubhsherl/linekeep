import { DEFAULT_CRON } from "./config.mjs";
import {
  istTimeToCron, parseBucketName, parseCron, parseD1Name, parseDays, parseDomain, parseEmail, parseEmailList,
  parseEnvName, parseMegabytes, parseRegion, parseSessionDuration, parseTeamName, parseWorkerName,
} from "./validate.mjs";

export const FEATURE_OPTIONS = [
  {
    value: "access",
    label: "Admin protection with Cloudflare Access",
    hint: "strongly recommended; without it the admin API returns 401 outside local development",
  },
  { value: "email", label: "Daily email summary (Mailgun)", hint: "needs a Mailgun domain and API key" },
  { value: "retention", label: "Recording retention", hint: "deletes recording audio after N days; call logs are kept" },
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
  return { access: picked.includes("access"), email: picked.includes("email"), retention: picked.includes("retention") };
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
    let cron;
    if (m.cron !== undefined) {
      const r = parseCron(m.cron);
      if (!r.ok) throw new Error(`Invalid answer "email.cron": ${r.error}`);
      cron = r.value;
    } else {
      const time = await field(ctx, {
        key: "email.timeIst", fileValue: m.timeIst, def: "18:00",
        parse: (v) => {
          const r = istTimeToCron(v);
          return r.ok ? { ok: true, value: r.value } : r;
        },
        prompt: "Send time in IST (24h HH:MM)",
        explain: "\nThe job runs on a UTC cron; the IST time you give is converted (IST = UTC+5:30). Default 18:00 IST = 30 12 * * * UTC.",
      });
      cron = time;
    }
    answers.email = {
      domain, region, cron, recipients,
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
      explain: `\nRetention deletes recording AUDIO only (from R2). Call logs, customers and chats are kept. It runs in the daily cron (${DEFAULT_CRON} UTC unless email sets another time).`,
    });
    answers.retention = { days };
  }
  return { answers, secrets };
}
