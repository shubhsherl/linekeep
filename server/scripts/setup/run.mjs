import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { HELP, parseArgs } from "./args.mjs";
import { buildWranglerConfig } from "./config.mjs";
import { chooseFeatures, collectAnswers } from "./answers.mjs";
import { createCloudflare } from "./cloudflare.mjs";
import { probePermissions, renderProbeReport } from "./permissions.mjs";
import { buildPlan, COST_NOTES, describeAnswers, accessAppName } from "./plan.mjs";
import { executePlan, workerHost } from "./steps.mjs";
import { createUi } from "./ui.mjs";
import { parseApiToken } from "./validate.mjs";
import { createMasker, createWrangler, WRANGLER_ENTRY } from "./wrangler.mjs";

export function realFs(cwd) {
  const abs = (p) => resolve(cwd, p);
  return {
    exists: (p) => existsSync(abs(p)),
    read: (p) => readFileSync(abs(p), "utf8"),
    write: (p, content) => {
      writeFileSync(abs(p), content, { mode: 0o600 });
      chmodSync(abs(p), 0o600);
    },
  };
}

export function defaultDeps() {
  const cwd = process.cwd();
  return {
    cwd,
    env: process.env,
    nodeVersion: process.versions.node,
    ui: createUi(),
    fs: realFs(cwd),
    fetch: globalThis.fetch,
    createCloudflare,
    createWrangler,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    randomHex: (n) => randomBytes(n).toString("hex"),
    verifyAttempts: 5,
  };
}

const DASH = "https://dash.cloudflare.com";

function prerequisites(deps) {
  const problems = [];
  const major = Number(deps.nodeVersion.split(".")[0]);
  if (!(major >= 22)) problems.push(`Node.js 22 or newer is required (found ${deps.nodeVersion}).`);
  let isServer = false;
  try {
    isServer = deps.fs.exists("package.json") && JSON.parse(deps.fs.read("package.json")).name === "@linekeep/server";
  } catch {
    /* handled below */
  }
  if (!isServer) problems.push("Run this from the server/ directory of the Linekeep repository (npm run setup).");
  else if (!deps.fs.exists(WRANGLER_ENTRY)) problems.push("Wrangler is not installed. Run `npm ci` in server/ first.");
  return problems;
}

function loadAnswersFile(deps, path) {
  if (!path) return {};
  let parsed;
  try {
    parsed = JSON.parse(deps.fs.read(path));
  } catch (error) {
    throw new Error(`Could not read --answers file "${path}": ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The --answers file must contain a JSON object.");
  for (const bad of ["apiToken", "token", "cloudflareApiToken", "mailgunApiKey"]) {
    if (bad in parsed) throw new Error(`Refusing "${bad}" in the answers file: secrets are never read from disk. Use CLOUDFLARE_API_TOKEN / MAILGUN_API_KEY or the hidden prompts.`);
  }
  return parsed;
}

async function obtainToken(deps, ctx) {
  const fromEnv = deps.env.CLOUDFLARE_API_TOKEN?.trim();
  if (fromEnv) {
    const r = parseApiToken(fromEnv);
    if (!r.ok) throw new Error(`CLOUDFLARE_API_TOKEN is set but ${r.error}`);
    return r.value;
  }
  if (ctx.yes) throw new Error("Set CLOUDFLARE_API_TOKEN (the token is never read from files).");
  deps.ui.say("Create an API token at " + `${DASH}/profile/api-tokens` + " (see the permissions listed at the end of this run if a check fails).");
  return deps.ui.hidden("Cloudflare API token (input hidden)", { parse: parseApiToken });
}

async function chooseAccount(deps, cf, file, yes) {
  let accounts;
  try {
    accounts = await cf.listAccounts();
  } catch (error) {
    const v = await cf.verifyToken([]).catch(() => ({ active: false }));
    if (!v.active) throw new Error("The API token was rejected by Cloudflare (invalid, expired or revoked).");
    throw error;
  }
  const verified = await cf.verifyToken(accounts.map((a) => a.id));
  if (!verified.active) throw new Error("The API token is not active (invalid, expired or revoked).");
  deps.ui.say("[ok] API token verified");
  if (accounts.length === 0) throw new Error("The token can see no accounts. Scope it to your account with Account Settings: Read.");
  if (file.accountId) {
    const hit = accounts.find((a) => a.id === file.accountId);
    if (!hit) throw new Error('"accountId" from the answers file is not visible to this token.');
    return hit;
  }
  if (accounts.length === 1) {
    deps.ui.say(`[ok] Account: ${accounts[0].name}`);
    return accounts[0];
  }
  if (yes) throw new Error('Several accounts are visible; set "accountId" in the --answers file.');
  return deps.ui.select("Which Cloudflare account?", accounts.map((a) => ({ value: a, label: a.name, hint: a.id })));
}

async function discover(cf, accountId, answers) {
  const safe = async (fn) => {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  };
  const d1 = await safe(() => cf.findD1(accountId, answers.d1Name));
  const r2 = await safe(() => cf.findBucket(accountId, answers.r2Name));
  const apps = answers.features.access ? await safe(() => cf.listAccessApps(accountId)) : undefined;
  const label = (found) => (found === undefined ? "unknown" : found ? "exists, will be reused" : "will be created");
  return [
    `  D1 database:  ${label(d1)}`,
    `  R2 bucket:    ${label(r2)}`,
    ...(answers.features.access ? [`  Access app:   ${label(apps === undefined ? undefined : apps.some((a) => a.name === accessAppName(answers.env)))}`] : []),
  ];
}

function finalReport(deps, ctx, state) {
  const { say } = deps.ui;
  const { answers } = ctx;
  const url = state.workerUrl ?? `https://${workerHost(ctx, state)}`;
  say("");
  say("=== Linekeep backend is deployed ===");
  say(`Worker URL (give this to Android users / put in the invitation QR): ${url}`);
  say(`Admin URL:  ${url}/admin`);
  if (answers.features.access) say(`Access:     ${state.accessIssuer} (application "${accessAppName(answers.env)}")`);
  else {
    say("");
    say("[!!] ADMIN PROTECTION IS OFF. Cloudflare Access is not configured, so /admin and /v1/admin return 401 in");
    say("[!!] non-development environments and the admin is unreachable until you configure Access");
    say("[!!] (re-run setup and enable Access, or follow the Cloudflare Access section of server/README.md).");
  }
  say("");
  say("Created:  " + (state.created.join("; ") || "nothing"));
  say("Reused:   " + (state.reused.join("; ") || "nothing"));
  if (state.updated.length) say("Updated:  " + state.updated.join("; "));
  say("Secrets set (names only): " + (state.secretsSet.join(", ") || "none (all existing secrets kept)"));
  if (state.backedUp) say(`Previous config backed up to: ${state.backedUp}`);
  say("");
  say("Next steps:");
  say(`  1. Open ${url}/admin and sign in${answers.features.access ? " through Cloudflare Access" : ""}.`);
  say("  2. Create your first employee, then generate an invitation QR code.");
  say(`  3. Build and install the Android app: ./gradlew assembleRelease (from the repository root); see docs/SETUP.md.`);
  say(`  4. In the app, use the Worker URL above (or scan the invitation QR).`);
  say("");
  say("Security: now revoke this API token or narrow it to what you still need (Cloudflare dashboard > My Profile > API Tokens).");
  say("It was only held in memory and passed to wrangler through its environment; it was not written anywhere.");
}

/** Returns a process exit code. All collaborators are injectable through `deps`. */
export async function run(argv, deps = defaultDeps()) {
  const masker = deps.masker ?? createMasker();
  const { ui } = deps;
  const say = (m = "") => ui.say(m);
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    ui.warn(error.message);
    return 2;
  }
  if (args.help) {
    say(HELP);
    return 0;
  }

  try {
    const problems = prerequisites(deps);
    if (problems.length) {
      for (const p of problems) ui.warn(`[!!] ${p}`);
      return 1;
    }
    const file = loadAnswersFile(deps, args.answers);
    const yes = args.yes;
    const dryRun = args.dryRun;
    const ctx = { ui, file, yes, dryRun, env: deps.env, envFlag: args.env };

    let cf = null;
    let wrangler = null;
    let account = { id: file.accountId ?? "<ACCOUNT_ID>", name: "(dry run)" };
    if (dryRun) {
      say("[..] Dry run: no token verification, no REST probes, no writes and no mutating calls will be made.");
    } else {
      const reachable = await deps.fetch("https://api.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(10_000) }).then(() => true, () => false);
      if (!reachable) throw new Error("Cannot reach api.cloudflare.com. Check your network connection or proxy settings.");
      const token = await obtainToken(deps, ctx);
      masker.add(token);
      cf = deps.createCloudflare({ token });
      account = await chooseAccount(deps, cf, file, yes);
      wrangler = deps.createWrangler({ cwd: deps.cwd, token, accountId: account.id, masker });
    }

    say("");
    const features = await chooseFeatures(ctx);

    if (!dryRun) {
      say("");
      say("Checking token permissions (read-only probes):");
      const results = await probePermissions(cf, account.id, Object.entries(features).filter(([, v]) => v).map(([k]) => k));
      if (!renderProbeReport(results, say)) {
        ui.warn("\nStopped before changing anything: fix the token permissions above and re-run.");
        return 1;
      }
    }

    let organization;
    if (!dryRun && features.access) organization = await cf.getOrganization(account.id);
    const { answers, secrets } = await collectAnswers(ctx, features, { organization });
    for (const v of Object.values(secrets)) masker.add(v);

    const plan = buildPlan(answers);
    say("");
    say("Plan");
    say("----");
    for (const line of describeAnswers(answers)) say(`  ${line}`);
    say("");
    if (!dryRun) {
      say("Existing resources:");
      for (const line of await discover(cf, account.id, answers)) say(line);
      say("");
    }
    for (const line of COST_NOTES) say(line);
    say("");
    if (!features.access) {
      say("[!!] Admin protection is OFF: /admin and /v1/admin will return 401 in non-development environments until Access is set up.");
      say("");
    }
    plan.forEach((s, i) => say(`  ${i + 1}. ${s.title}`));
    say("");

    const configExists = deps.fs.exists("wrangler.jsonc");
    if (!dryRun) {
      if (configExists) {
        if (!yes && !(await ui.confirm("server/wrangler.jsonc already exists. Copy it to a timestamped wrangler.jsonc.<time>.bak and replace it (other environments are kept)?", false))) {
          ui.warn("Cancelled; nothing was changed.");
          return 1;
        }
      }
      if (!yes && !(await ui.confirm("Proceed with this plan?", false))) {
        ui.warn("Cancelled; nothing was changed.");
        return 1;
      }
    }

    const execCtx = {
      answers, secrets, cf, wrangler, fs: deps.fs, ui, say, yes, dryRun, accountId: account.id,
      configPath: "wrangler.jsonc", now: deps.now, sleep: deps.sleep, fetch: deps.fetch,
      randomHex: deps.randomHex, verifyAttempts: deps.verifyAttempts ?? 5,
    };
    if (dryRun) {
      say("Configuration that would be written to server/wrangler.jsonc (IDs shown as placeholders):");
      const preview = buildWranglerConfig(answers, { accountId: account.id, d1Id: "<D1_DATABASE_ID>", accessIssuer: "https://<team>.cloudflareaccess.com", accessAudience: "<ACCESS_AUDIENCE>" });
      say(JSON.stringify(preview.env[answers.env], null, 2));
      say("");
    }
    say(dryRun ? "Dry run steps:" : "Executing:");
    let state;
    try {
      state = await executePlan(plan, execCtx);
    } catch (error) {
      ui.warn("");
      ui.warn(`[!!] Step "${error.stepId}" failed: ${masker.mask(error.message)}`);
      ui.warn(`Completed before the failure: ${error.completed?.length ? error.completed.join(", ") : "nothing"}.`);
      ui.warn("Every step is idempotent: fix the problem and re-run setup to resume; existing resources are reused.");
      return 1;
    }
    if (dryRun) {
      say("");
      say("Dry run complete: nothing was created or changed.");
      return 0;
    }
    finalReport(deps, execCtx, state);
    return 0;
  } catch (error) {
    ui.warn(`[!!] ${masker.mask(error.message)}`);
    return 1;
  } finally {
    ui.close?.();
  }
}
