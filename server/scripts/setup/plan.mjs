// PURE: normalized answers -> ordered steps. No I/O.
import { effectiveCron } from "./config.mjs";
import { cronToIst } from "./validate.mjs";

export const ACCESS_PATHS = ["/admin", "/admin/*", "/v1/admin", "/v1/admin/*"];

export function accessAppName(env) {
  return `Linekeep ${env} admin`;
}
export function accessPolicyName(env) {
  return `Linekeep ${env} admins`;
}

export function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * Each step: { id, title, detail[], mutating }. Order matters:
 * D1/R2 and config first, migrations, first deploy (creates the Worker so secrets have a target),
 * secrets, then Access (needs the Worker hostname), redeploy with Access vars, verify.
 */
export function buildPlan(answers) {
  const f = answers.features;
  const steps = [];
  const add = (id, title, mutating, detail = []) => steps.push({ id, title, mutating, detail });

  add("subdomain", "Ensure a workers.dev subdomain exists", true, ["Reused when already set; otherwise you choose a name (free)."]);
  add("d1", `Find or create D1 database "${answers.d1Name}"`, true, ["Reused when a database of that exact name exists (data is never touched)."]);
  add("r2", `Find or create private R2 bucket "${answers.r2Name}"`, true, ["Reused when it exists.", "Checks that no public r2.dev URL or custom domain is attached."]);
  add("config", "Write server/wrangler.jsonc", true, [
    "Private, git-ignored; holds IDs and non-secret vars only.",
    "An existing file is copied to wrangler.jsonc.<timestamp>.bak first.",
  ]);
  add("migrate", `Apply D1 migrations to "${answers.d1Name}" (remote)`, true, ["wrangler d1 migrations apply DB --remote; already-applied migrations are skipped."]);
  add("deploy", `Deploy Worker "${answers.workerName}" (--env ${answers.env})`, true);
  const secretNames = ["TOKEN_HASH_SECRET (only if not already set; never rotated)"];
  if (f.email) secretNames.push("EMAIL_IDS", "MAILGUN_API_KEY", "MAILGUN_DOMAIN", "MAILGUN_REGION", ...(answers.email.from ? ["MAILGUN_FROM_EMAIL"] : []));
  add("secrets", "Set Worker secrets", true, secretNames.map((n) => `secret: ${n}`));
  if (f.access) {
    const a = answers.access;
    add("access", `Protect the admin with Cloudflare Access ("${accessAppName(answers.env)}")`, true, [
      `Paths: ${ACCESS_PATHS.join(", ")} on the Worker hostname.`,
      `Allow policy for ${a.emails.length} admin address(es); session ${a.sessionDuration}.`,
      a.oneTimePin ? "Enable the One-time PIN login method if absent." : "No One-time PIN: only users with a login provider you configured can sign in.",
      "An existing app is reused; only its policy emails may change, after you review a diff.",
      "Zero Trust organization is created only with your consent when none exists.",
    ]);
    add("redeploy", "Redeploy with ACCESS_TEAM_DOMAIN and ACCESS_AUDIENCE", true);
  }
  add("verify", "Verify the deployment", false, [
    "/health returns 200",
    ...(f.access ? ["/admin redirects (302) to the Access login"] : []),
    "/v1/device/customers without a token returns 401",
  ]);
  return steps;
}

/** Human-readable summary incl. free-tier and cost notes. Emails are masked. */
export function describeAnswers(answers) {
  const f = answers.features;
  const lines = [
    `Environment:        ${answers.env}  (ENVIRONMENT=${answers.env === "production" ? "production" : "development"})`,
    `Worker:             ${answers.workerName}`,
    `D1 database:        ${answers.d1Name}`,
    `R2 bucket:          ${answers.r2Name}  (private; never made public)`,
    `Max recording:      ${answers.maxRecordingMb} MB`,
    `Admin protection:   ${f.access ? `Cloudflare Access for ${answers.access.emails.map(maskEmail).join(", ")}, session ${answers.access.sessionDuration}, one-time PIN ${answers.access.oneTimePin ? "on" : "off"}` : "OFF (admin returns 401 until Access is configured)"}`,
    `Daily email:        ${f.email ? `Mailgun ${answers.email.domain} (${answers.email.region}), ${answers.email.recipients.length} recipient(s), cron "${answers.email.cron}" UTC${cronToIst(answers.email.cron) ? ` = ${cronToIst(answers.email.cron)} IST` : ""}` : "off"}`,
    `Recording retention: ${f.retention ? `delete audio older than ${answers.retention.days} days (call logs kept)` : "off"}`,
    `Cron trigger:       ${effectiveCron(answers) ? `"${effectiveCron(answers)}" (UTC)` : "none"}`,
  ];
  return lines;
}

export const COST_NOTES = [
  "Cost notes (Cloudflare plans change; check current pricing):",
  "  - Workers, D1 and R2 have free tiers; R2 storage and operations beyond the free allowance, and Workers beyond",
  "    the free request limits, are billed. R2 requires a payment method on the account even for the free tier.",
  "  - Cloudflare Access (Zero Trust) is free for up to 50 users.",
  "  - Mailgun is billed by Mailgun, not Cloudflare.",
];
