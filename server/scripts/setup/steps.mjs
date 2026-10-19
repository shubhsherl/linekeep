import { buildWranglerConfig, backupName, parseJsonc, renderWranglerConfig } from "./config.mjs";
import { ACCESS_PATHS, accessAppName, accessPolicyName, maskEmail } from "./plan.mjs";
import { parseSubdomain } from "./validate.mjs";

export class StepError extends Error {
  constructor(stepId, message) {
    super(message);
    this.stepId = stepId;
  }
}

const POLICY_FIELDS = ["name", "decision", "include", "exclude", "require", "session_duration", "purpose_justification_required", "purpose_justification_prompt", "approval_required", "approval_groups", "isolation_required"];
const APP_FIELDS = ["name", "type", "domain", "destinations", "session_duration", "allowed_idps", "auto_redirect_to_identity", "app_launcher_visible", "self_hosted_domains"];
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

export function workerHost(ctx, state) {
  return `${ctx.answers.workerName}.${state.subdomain}.workers.dev`;
}

function note(state, kind, text) {
  state[kind].push(text);
}

async function writeConfig(ctx, state) {
  const { answers } = ctx;
  const ids = { accountId: ctx.accountId, d1Id: state.d1Id, accessIssuer: state.accessIssuer, accessAudience: state.accessAudience };
  let existingEnvs = {};
  if (ctx.fs.exists(ctx.configPath)) {
    const current = ctx.fs.read(ctx.configPath);
    if (!state.backedUp) {
      const backup = backupName(ctx.now());
      ctx.fs.write(backup, current);
      state.backedUp = backup;
      ctx.say(`      backed up existing config to ${backup}`);
    }
    try {
      const parsed = parseJsonc(current);
      const { [answers.env]: _replaced, ...others } = parsed.env ?? {};
      existingEnvs = others;
    } catch {
      ctx.say("      [!!] existing wrangler.jsonc could not be parsed; other environments are only kept in the backup");
    }
  }
  ctx.fs.write(ctx.configPath, renderWranglerConfig(buildWranglerConfig(answers, ids, existingEnvs)));
}

async function checkBucketPrivacy(ctx, state) {
  const exposure = await ctx.cf.bucketExposure(ctx.accountId, ctx.answers.r2Name);
  if (!exposure) {
    ctx.say("      [!!] could not verify the bucket has no public r2.dev URL or custom domain; check it in the dashboard");
    return;
  }
  if (exposure.customDomains.length) {
    throw new StepError("r2", `Bucket "${ctx.answers.r2Name}" has a custom domain attached (${exposure.customDomains.join(", ")}). Recordings must stay private: remove it in the dashboard (R2 > bucket > Settings), then re-run.`);
  }
  if (exposure.managedEnabled) {
    const msg = `Bucket "${ctx.answers.r2Name}" has its public r2.dev URL ENABLED.`;
    if (ctx.yes) throw new StepError("r2", `${msg} Disable it (R2 > bucket > Settings > Public Development URL) or re-run interactively to let setup disable it.`);
    if (!(await ctx.ui.confirm(`${msg} Disable it now?`, true))) throw new StepError("r2", `${msg} Recordings must be private; setup stopped.`);
    await ctx.cf.disableManagedDomain(ctx.accountId, ctx.answers.r2Name);
    ctx.say("      [ok] disabled the public r2.dev URL");
  } else {
    ctx.say("      [ok] bucket is private (no r2.dev URL, no custom domain)");
  }
}

function diffEmails(current, desired) {
  return { added: desired.filter((e) => !current.includes(e)), removed: current.filter((e) => !desired.includes(e)) };
}

async function ensureAccess(ctx, state) {
  const { cf, accountId, answers } = ctx;
  const a = answers.access;

  let org = await cf.getOrganization(accountId);
  if (!org) {
    if (!a.teamName || !a.createOrganization) throw new StepError("access", "No Zero Trust organization exists and creation was not approved. Enable Zero Trust once at https://one.dash.cloudflare.com and re-run.");
    org = await cf.createOrganization(accountId, `${a.teamName}.cloudflareaccess.com`, a.teamName);
    note(state, "created", `Zero Trust organization ${org.auth_domain ?? a.teamName}`);
  } else {
    note(state, "reused", `Zero Trust organization ${org.auth_domain}`);
  }
  state.accessIssuer = `https://${org.auth_domain}`;

  if (a.oneTimePin) {
    const idps = await cf.listIdentityProviders(accountId);
    if (idps.some((p) => p.type === "onetimepin")) note(state, "reused", "One-time PIN login method");
    else {
      await cf.createOneTimePin(accountId);
      note(state, "created", "One-time PIN login method");
    }
  }

  const appName = accessAppName(answers.env);
  const policyName = accessPolicyName(answers.env);
  const host = workerHost(ctx, state);
  const emailRules = a.emails.map((email) => ({ email: { email } }));
  const apps = await cf.listAccessApps(accountId);
  const existing = apps.find((app) => app.name === appName);

  if (!existing) {
    const policy = await cf.createAccessPolicy(accountId, { name: policyName, decision: "allow", include: emailRules });
    const app = await cf.createAccessApp(accountId, {
      name: appName,
      type: "self_hosted",
      destinations: ACCESS_PATHS.map((p) => ({ type: "public", uri: `${host}${p}` })),
      session_duration: a.sessionDuration,
      app_launcher_visible: false,
      policies: [{ id: policy.id, precedence: 1 }],
    });
    state.accessAudience = app.aud;
    note(state, "created", `Access application "${appName}" and policy "${policyName}"`);
    return;
  }

  const app = await cf.getAccessApp(accountId, existing.id);
  state.accessAudience = app.aud ?? existing.aud;
  note(state, "reused", `Access application "${appName}"`);
  const covered = new Set((app.destinations ?? []).map((d) => d.uri));
  const missing = ACCESS_PATHS.filter((p) => !covered.has(`${host}${p}`));
  if (missing.length) {
    ctx.say(`      [!!] existing app does not list: ${missing.map((p) => host + p).join(", ")} (left unchanged; fix in the dashboard if /admin is not protected)`);
  }

  const attached = app.policies ?? [];
  const ours = attached.find((p) => p.name === policyName) ?? attached.find((p) => p.decision === "allow");
  if (!ours) {
    const policy = await cf.createAccessPolicy(accountId, { name: policyName, decision: "allow", include: emailRules });
    await cf.updateAccessApp(accountId, existing.id, {
      ...pick(app, APP_FIELDS),
      policies: [...attached.map((p, i) => ({ id: p.id, precedence: p.precedence ?? i + 1 })), { id: policy.id, precedence: attached.length + 1 }],
    });
    note(state, "created", `Access policy "${policyName}" (attached to the existing application)`);
    return;
  }
  const policy = await cf.getAccessPolicy(accountId, ours.id);
  const current = (policy.include ?? []).filter((r) => r.email).map((r) => r.email.email.toLowerCase());
  const { added, removed } = diffEmails(current, a.emails);
  if (!added.length && !removed.length) {
    note(state, "reused", `Access policy "${policy.name}" (emails unchanged)`);
    return;
  }
  ctx.say(`      Access policy "${policy.name}" differs from your answers:`);
  for (const e of added) ctx.say(`        + ${maskEmail(e)}`);
  for (const e of removed) ctx.say(`        - ${maskEmail(e)}`);
  const proceed = ctx.yes || (await ctx.ui.confirm("Update the policy's allowed emails to match?", false));
  if (!proceed) {
    ctx.say("      [..] policy left unchanged");
    note(state, "reused", `Access policy "${policy.name}" (emails NOT changed)`);
    return;
  }
  const include = [...(policy.include ?? []).filter((r) => !r.email), ...emailRules];
  await cf.updateAccessPolicy(accountId, policy.id, { ...pick(policy, POLICY_FIELDS), include });
  note(state, "updated", `Access policy "${policy.name}" emails (+${added.length} -${removed.length})`);
}

async function verify(ctx, state) {
  const base = state.workerUrl;
  const get = async (path) => {
    try {
      return await ctx.fetch(`${base}${path}`, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    } catch {
      return null;
    }
  };
  const retry = async (path, ok) => {
    let res = null;
    for (let attempt = 0; attempt < ctx.verifyAttempts; attempt++) {
      res = await get(path);
      if (res && ok(res)) return { pass: true, res };
      await ctx.sleep(3000);
    }
    return { pass: false, res };
  };
  const checks = [];
  const h = await retry("/health", (r) => r.status === 200);
  checks.push([`GET /health -> 200`, h.pass, h.res?.status]);
  if (ctx.answers.features.access) {
    const issuerHost = new URL(state.accessIssuer).host;
    const a = await retry("/admin", (r) => r.status === 302 && (r.headers.get("location") ?? "").includes(issuerHost));
    checks.push([`GET /admin -> 302 to ${issuerHost}`, a.pass, a.res?.status]);
  }
  const d = await retry("/v1/device/customers", (r) => r.status === 401);
  checks.push([`GET /v1/device/customers without token -> 401`, d.pass, d.res?.status]);
  for (const [label, pass, status] of checks) ctx.say(`      ${pass ? "[ok]" : "[!!]"} ${label}${pass ? "" : ` (got ${status ?? "no response"})`}`);
  if (checks.some(([, pass]) => !pass)) throw new StepError("verify", "Verification failed; the deployment exists but did not behave as expected. Fresh workers.dev hostnames can take a minute to propagate; re-run setup to verify again.");
}

export const handlers = {
  async subdomain(ctx, state) {
    let sub = await ctx.cf.getSubdomain(ctx.accountId);
    if (sub) {
      note(state, "reused", `workers.dev subdomain ${sub}`);
    } else {
      if (ctx.answers.subdomain) sub = parseSubdomain(ctx.answers.subdomain).value;
      else if (ctx.yes) throw new StepError("subdomain", 'No workers.dev subdomain exists. Add "subdomain" to the --answers file.');
      else sub = await ctx.ui.ask("Choose a workers.dev subdomain for this account (public part of your URL)", { parse: parseSubdomain });
      if (!sub) throw new StepError("subdomain", "Invalid workers.dev subdomain in answers.");
      await ctx.cf.putSubdomain(ctx.accountId, sub);
      note(state, "created", `workers.dev subdomain ${sub}`);
    }
    state.subdomain = sub;
  },

  async d1(ctx, state) {
    let db = await ctx.cf.findD1(ctx.accountId, ctx.answers.d1Name);
    if (db) note(state, "reused", `D1 database ${db.name}`);
    else {
      db = await ctx.cf.createD1(ctx.accountId, ctx.answers.d1Name);
      note(state, "created", `D1 database ${db.name}`);
    }
    state.d1Id = db.id;
  },

  async r2(ctx, state) {
    const found = await ctx.cf.findBucket(ctx.accountId, ctx.answers.r2Name);
    if (found) note(state, "reused", `R2 bucket ${found.name}`);
    else {
      await ctx.cf.createBucket(ctx.accountId, ctx.answers.r2Name);
      note(state, "created", `R2 bucket ${ctx.answers.r2Name}`);
    }
    await checkBucketPrivacy(ctx, state);
  },

  async config(ctx, state) {
    await writeConfig(ctx, state);
    note(state, "created", "server/wrangler.jsonc (private, git-ignored)");
  },

  async migrate(ctx) {
    await ctx.wrangler.migrate(ctx.answers.env);
  },

  async deploy(ctx, state) {
    const { url } = await ctx.wrangler.deploy(ctx.answers.env);
    state.workerUrl = `https://${workerHost(ctx, state)}`;
    if (url && url !== state.workerUrl) ctx.say(`      note: wrangler reported ${url}`);
  },

  async redeploy(ctx, state) {
    if (!state.accessAudience) throw new StepError("redeploy", "Access application audience unknown; cannot configure the Worker.");
    await writeConfig(ctx, state);
    await ctx.wrangler.deploy(ctx.answers.env);
  },

  async secrets(ctx, state) {
    const env = ctx.answers.env;
    const names = await ctx.wrangler.secretNames(env);
    if (names === null) {
      throw new StepError("secrets", "Could not list existing Worker secrets. Refusing to set TOKEN_HASH_SECRET without knowing whether one exists (rotating it would invalidate every device and invitation). Re-run once wrangler can reach the Worker.");
    }
    const toSet = {};
    if (names.includes("TOKEN_HASH_SECRET")) note(state, "reused", "secret TOKEN_HASH_SECRET (kept, never rotated)");
    else {
      toSet.TOKEN_HASH_SECRET = ctx.randomHex(32);
      state.secretsSet.push("TOKEN_HASH_SECRET");
    }
    if (ctx.answers.features.email) {
      const m = ctx.answers.email;
      toSet.EMAIL_IDS = m.recipients.join(",");
      toSet.MAILGUN_API_KEY = ctx.secrets.mailgunApiKey;
      toSet.MAILGUN_DOMAIN = m.domain;
      toSet.MAILGUN_REGION = m.region;
      if (m.from) toSet.MAILGUN_FROM_EMAIL = m.from;
      state.secretsSet.push(...Object.keys(toSet).filter((k) => k !== "TOKEN_HASH_SECRET"));
    }
    if (Object.keys(toSet).length) await ctx.wrangler.putSecrets(env, toSet);
  },

  access: ensureAccess,
  verify,
};

/**
 * Runs the plan sequentially. In dry-run mode nothing is invoked and no adapter is touched.
 * On failure, throws StepError-like with `completed` listing finished steps so a re-run resumes cleanly.
 */
export async function executePlan(plan, ctx) {
  const state = { created: [], reused: [], updated: [], secretsSet: [], completed: [], subdomain: null, backedUp: null };
  const total = plan.length;
  for (const [i, step] of plan.entries()) {
    ctx.say(`[${i + 1}/${total}] ${step.title}`);
    if (ctx.dryRun) {
      for (const d of step.detail) ctx.say(`      (dry run) ${d}`);
      continue;
    }
    try {
      await handlers[step.id](ctx, state);
    } catch (error) {
      error.stepId ??= step.id;
      error.completed = [...state.completed];
      error.state = state;
      throw error;
    }
    state.completed.push(step.id);
    ctx.say("      [ok] done");
  }
  return state;
}
