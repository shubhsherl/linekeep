import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "./setup/args.mjs";
import { backupName, buildWranglerConfig, DEFAULT_CRON, parseJsonc, renderWranglerConfig } from "./setup/config.mjs";
import { probePermissions, requiredPermissions } from "./setup/permissions.mjs";
import { assertNoSecretsInAnswers } from "./setup/answers.mjs";
import { buildPlan, describeAnswers } from "./setup/plan.mjs";
import { parseFirebaseField, parseGoogleServices, parseServiceAccount } from "./setup/push.mjs";
import { buildMetaCalls, describeMetaCalls, PLACEHOLDERS, registerWebhook, webhookUrl } from "./setup/whatsapp.mjs";
import { run } from "./setup/run.mjs";
import {
  parseBucketName, parseD1Name, parseDays, parseDomain, parseEmail, parseEmailList, parseIstTime,
  parseCredential, parseEnvName, parseMegabytes, parseMetaId, parseSessionDuration, parseWorkerName,
} from "./setup/validate.mjs";
import { WRANGLER_ENTRY, createMasker } from "./setup/wrangler.mjs";

const TOKEN = "cfut_SECRETTOKEN0123456789abcdefABCDEF";
const MAILGUN_KEY = "key-SECRETMAILGUN9876543210";
const HASH = "ab".repeat(32);
const BOSS = "boss@example.com";
const ADMIN = "owner@example.com";
const strip = (text) => JSON.parse(text.split("\n").filter((l) => !l.startsWith("//")).join("\n"));

// ---------- fakes ----------
const MUTATING = /^(put|create|disable|update)/;

function fakeCf(over = {}) {
  const s = {
    accounts: [{ id: "acc1", name: "Account One" }], subdomain: "me", d1: null, bucket: null,
    org: { auth_domain: "team.cloudflareaccess.com" }, idps: [], apps: [], policies: {},
    denied: [], exposure: { managedEnabled: false, customDomains: [] }, ...over,
  };
  const calls = [];
  const rec = (name, fn) => async (...args) => {
    calls.push({ name, args });
    return fn(...args);
  };
  const cf = {
    calls,
    state: s,
    mutations: () => calls.filter((c) => MUTATING.test(c.name)).map((c) => c.name),
    raw: async (method, path) => {
      calls.push({ name: "raw", args: [method, path] });
      const denied = s.denied.some((f) => path.includes(f));
      return { status: denied ? 403 : 200, ok: !denied, result: null, errors: [] };
    },
    listAccounts: rec("listAccounts", () => s.accounts),
    verifyToken: rec("verifyToken", () => ({ active: true, kind: "user" })),
    getSubdomain: rec("getSubdomain", () => s.subdomain),
    putSubdomain: rec("putSubdomain", (_a, sub) => void (s.subdomain = sub)),
    findD1: rec("findD1", () => s.d1),
    createD1: rec("createD1", (_a, name) => (s.d1 = { id: "d1-new-id", name })),
    findBucket: rec("findBucket", () => s.bucket),
    createBucket: rec("createBucket", (_a, name) => (s.bucket = { name })),
    bucketExposure: rec("bucketExposure", () => s.exposure),
    disableManagedDomain: rec("disableManagedDomain", () => {}),
    getOrganization: rec("getOrganization", () => s.org),
    createOrganization: rec("createOrganization", (_a, domain) => (s.org = { auth_domain: domain })),
    listIdentityProviders: rec("listIdentityProviders", () => s.idps),
    createOneTimePin: rec("createOneTimePin", () => s.idps.push({ type: "onetimepin" })),
    listAccessApps: rec("listAccessApps", () => s.apps),
    getAccessApp: rec("getAccessApp", (_a, id) => s.apps.find((a) => a.id === id)),
    createAccessApp: rec("createAccessApp", (_a, body) => {
      const app = { id: "app1", aud: "aud-123", ...body, policies: body.policies.map((p) => ({ ...s.policies[p.id], ...p })) };
      s.apps.push(app);
      return app;
    }),
    updateAccessApp: rec("updateAccessApp", () => ({})),
    getAccessPolicy: rec("getAccessPolicy", (_a, id) => s.policies[id]),
    createAccessPolicy: rec("createAccessPolicy", (_a, body) => (s.policies.p1 = { id: "p1", ...body })),
    updateAccessPolicy: rec("updateAccessPolicy", (_a, id, body) => (s.policies[id] = { id, ...body })),
  };
  return cf;
}

function fakeWrangler(over = {}) {
  const w = {
    calls: [], secrets: over.secrets ?? [], masker: createMasker(), puts: [],
    secretNames: async () => {
      w.calls.push("secretNames");
      return w.secrets;
    },
    putSecrets: async (env, values) => {
      w.calls.push("putSecrets");
      w.puts.push({ env, values });
    },
    migrate: async () => void w.calls.push("migrate"),
    deploy: async () => {
      w.calls.push("deploy");
      return { url: "https://linekeep-api-production.me.workers.dev" };
    },
  };
  return w;
}

function fakeFs(files = {}) {
  const map = new Map(Object.entries({ "package.json": '{"name":"@linekeep/server"}', [WRANGLER_ENTRY]: "", ...files }));
  return {
    map,
    writes: [],
    exists: (p) => map.has(p),
    read: (p) => {
      if (!map.has(p)) throw new Error(`ENOENT ${p}`);
      return map.get(p);
    },
    write(p, c) {
      this.writes.push(p);
      map.set(p, c);
    },
  };
}

const response = (status, location) => ({ status, headers: { get: (h) => (h === "location" ? location ?? null : null) } });

function makeDeps(over = {}) {
  const out = [];
  const cf = over.cf ?? fakeCf();
  const wr = over.wrangler ?? fakeWrangler();
  const fs = over.fs ?? fakeFs();
  const ui = {
    say: (m = "") => void out.push(String(m)),
    warn: (m = "") => void out.push(String(m)),
    confirm: over.confirm ?? (async () => true),
    ask: async () => {
      throw new Error("unexpected ask");
    },
    select: async () => {
      throw new Error("unexpected select");
    },
    multiselect: async () => {
      throw new Error("unexpected multiselect");
    },
    hidden: async () => {
      throw new Error("unexpected hidden");
    },
    close() {},
    ...(over.ui ?? {}),
  };
  const deps = {
    cwd: "/x/server", env: { CLOUDFLARE_API_TOKEN: TOKEN, MAILGUN_API_KEY: MAILGUN_KEY, ...(over.env ?? {}) }, nodeVersion: "22.4.0",
    ui, fs,
    fetch: over.fetch ?? (async (url) => {
      if (url.includes("/health")) return response(200);
      if (url.includes("/admin")) return response(302, "https://team.cloudflareaccess.com/cdn-cgi/access/login/x");
      if (url.includes("/v1/device/customers")) return response(401);
      return response(200);
    }),
    createCloudflare: over.createCloudflare ?? (() => cf),
    createWrangler: over.createWrangler ?? (() => wr),
    now: () => new Date("2026-01-02T03:04:05Z"),
    sleep: async () => {},
    randomHex: (n) => "ab".repeat(n),
    verifyAttempts: 1,
    masker: createMasker(),
  };
  return { deps, out, cf, wr, fs };
}

const FULL = {
  features: ["access", "email", "retention"],
  access: { emails: [ADMIN], oneTimePin: true },
  email: { domain: "mg.example.com", recipients: [BOSS] },
  retention: { days: 14 },
};
const withAnswers = (fs, answers) => fs.map.set("answers.json", JSON.stringify(answers));
const runYes = (h, extra = []) => run(["--yes", "--answers", "answers.json", ...extra], h.deps);
const text = (h) => h.out.join("\n");

// ---------- pure units ----------
test("flag parsing", () => {
  assert.deepEqual(parseArgs([]), { yes: false, dryRun: false, answers: null, env: null, help: false });
  assert.deepEqual(parseArgs(["--yes", "--dry-run", "--answers", "a.json", "--env=dev", "--help"]), {
    yes: true, dryRun: true, answers: "a.json", env: "dev", help: true,
  });
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
  assert.throws(() => parseArgs(["--answers"]), /requires a value/);
  assert.throws(() => parseArgs(["--env", "--yes"]), /requires a value/);
});

test("validators", () => {
  assert.equal(parseEmail(" A@Example.COM ").value, "a@example.com");
  for (const bad of ["a", "a@b", "a b@c.com", "a@@c.com", "<a@c.com>", ""]) assert.equal(parseEmail(bad).ok, false, bad);
  assert.deepEqual(parseEmailList("a@x.com, b@x.com,a@x.com").value, ["a@x.com", "b@x.com"]);
  assert.equal(parseEmailList("").ok, false);
  assert.equal(parseEmailList("a@x.com,nope").ok, false);
  assert.equal(parseIstTime("18:00").value, "18:00");
  assert.equal(parseIstTime("5:15").value, "05:15");
  for (const bad of ["25:00", "18:60", "6pm", "", "18"]) assert.equal(parseIstTime(bad).ok, false, bad);
  assert.equal(DEFAULT_CRON, "*/30 * * * *");
  assert.equal(parseDomain("mg.example.com").ok, true);
  for (const bad of ["example", "https://mg.example.com", "mg.example.com/x", "-a.com"]) assert.equal(parseDomain(bad).ok, false, bad);
  assert.equal(parseWorkerName("linekeep-api-dev").ok, true);
  for (const bad of ["Upper", "-x", "x-", "a_b", ""]) assert.equal(parseWorkerName(bad).ok, false, bad);
  assert.equal(parseD1Name("linekeep_prod-1").ok, true);
  assert.equal(parseD1Name("bad name").ok, false);
  assert.equal(parseBucketName("linekeep-recordings-dev").ok, true);
  for (const bad of ["ab", "UPPER", "-abc", "abc-", "a_b_c"]) assert.equal(parseBucketName(bad).ok, false, bad);
  assert.equal(parseEnvName("production").ok, true);
  assert.equal(parseEnvName("Prod").ok, false);
  assert.equal(parseDays("30").value, 30);
  for (const bad of ["0", "-1", "1.5", "abc", "10000"]) assert.equal(parseDays(bad).ok, false, bad);
  assert.equal(parseMegabytes(100).value, 100);
  for (const bad of ["0", "501", "x"]) assert.equal(parseMegabytes(bad).ok, false, bad);
  assert.equal(parseSessionDuration("1h").ok, true);
  assert.equal(parseSessionDuration("1 hour").ok, false);
});

const base = (features, extra = {}) => ({
  env: "production", workerName: "linekeep-api-production", d1Name: "linekeep-production", r2Name: "linekeep-recordings-production",
  maxRecordingMb: 100, features: { access: false, email: false, retention: false, ...features },
  access: { emails: [ADMIN], sessionDuration: "1h", oneTimePin: true }, email: { domain: "mg.example.com", region: "us", timeIst: "18:00", recipients: [BOSS], from: null },
  retention: { days: 30 }, ...extra,
});
const ids = { accountId: "acc1", d1Id: "11111111-2222-3333-4444-555555555555", accessIssuer: "https://team.cloudflareaccess.com", accessAudience: "aud-1" };

test("config builder per feature combination", () => {
  for (const access of [false, true]) for (const email of [false, true]) for (const retention of [false, true]) {
    const answers = base({ access, email, retention });
    const rendered = renderWranglerConfig(buildWranglerConfig(answers, ids));
    const cfg = strip(rendered);
    const env = cfg.env.production;
    const label = JSON.stringify({ access, email, retention });
    assert.equal(env.name, "linekeep-api-production", label);
    assert.equal(env.d1_databases[0].database_name, "linekeep-production");
    assert.equal(env.d1_databases[0].database_id, ids.d1Id);
    assert.equal(env.r2_buckets[0].bucket_name, "linekeep-recordings-production");
    assert.equal(env.preview_urls, false);
    assert.equal(cfg.preview_urls, false);
    assert.equal(cfg.account_id, "acc1");
    assert.equal(cfg.d1_databases[0].database_name, "linekeep-local"); // local dev bindings kept
    assert.equal(env.vars.ENVIRONMENT, "production");
    assert.equal(env.vars.MAX_RECORDING_BYTES, "104857600");
    assert.equal(env.vars.CALL_SUMMARY_ENABLED, email ? "true" : "false");
    assert.equal(env.vars.CALL_SUMMARY_SEND_TIME, email ? "18:00" : undefined, label);
    assert.equal("ACCESS_TEAM_DOMAIN" in env.vars, access, label);
    assert.equal("ACCESS_AUDIENCE" in env.vars, access, label);
    assert.equal("RECORDING_RETENTION_DAYS" in env.vars, retention, label);
    assert.equal(Boolean(env.triggers), email || retention, label); // retention runs in the same cron
    if (env.triggers) assert.deepEqual(env.triggers.crons, [DEFAULT_CRON]);
    for (const secret of ["EMAIL_IDS", "MAILGUN_API_KEY", "MAILGUN_DOMAIN", "TOKEN_HASH_SECRET", BOSS, ADMIN, "mg.example.com"]) {
      assert.ok(!rendered.includes(secret), `${secret} leaked in ${label}`);
    }
  }
  const dev = buildWranglerConfig({ ...base({}), env: "dev" }, ids);
  assert.equal(dev.env.dev.vars.ENVIRONMENT, "development");
});

test("config builder keeps other environments and jsonc parsing handles comments", () => {
  const cfg = buildWranglerConfig(base({}), ids, { dev: { name: "keep" } });
  assert.equal(cfg.env.dev.name, "keep");
  assert.deepEqual(parseJsonc('{ // c\n "a": "x // not a comment", /* b */ "b": [1,], }'), { a: "x // not a comment", b: [1] });
  assert.match(backupName(new Date("2026-01-02T03:04:05Z")), /^wrangler\.jsonc\.20260102T030405Z\.bak$/);
});

test("plan ordering and summary", () => {
  const ids_ = (a) => buildPlan(a).map((s) => s.id);
  assert.deepEqual(ids_(base({})), ["subdomain", "d1", "r2", "config", "migrate", "deploy", "secrets", "verify"]);
  assert.deepEqual(ids_(base({ access: true, email: true })), [
    "subdomain", "d1", "r2", "config", "migrate", "deploy", "secrets", "access", "redeploy", "verify",
  ]);
  const summary = describeAnswers(base({ access: true, email: true })).join("\n");
  assert.ok(!summary.includes(BOSS) && !summary.includes(ADMIN));
  assert.match(summary, /18:00 IST/);
});

// ---------- permissions ----------
test("permission probes report ok / missing Access / missing D1", async () => {
  const core = requiredPermissions([]).map((p) => p.label);
  assert.deepEqual(core, ["Workers Scripts: Edit", "D1: Edit", "Workers R2 Storage: Edit", "Account Settings: Read"]);
  assert.equal(requiredPermissions(["access"]).length, 6);
  const ok = await probePermissions(fakeCf(), "acc1", ["access"]);
  assert.ok(ok.every((r) => r.ok));
  const noAccess = await probePermissions(fakeCf({ denied: ["/access/"] }), "acc1", ["access"]);
  assert.deepEqual(noAccess.filter((r) => !r.ok).map((r) => r.label), [
    "Access: Apps and Policies: Edit", "Access: Organizations, Identity Providers, and Groups: Edit",
  ]);
  const accessSkipped = await probePermissions(fakeCf({ denied: ["/access/"] }), "acc1", []);
  assert.ok(accessSkipped.every((r) => r.ok), "unneeded features are not probed");
  const noD1 = await probePermissions(fakeCf({ denied: ["/d1/"] }), "acc1", []);
  assert.deepEqual(noD1.filter((r) => !r.ok).map((r) => r.label), ["D1: Edit"]);
});

test("missing permissions stop before any mutation", async () => {
  const h = makeDeps({ cf: fakeCf({ denied: ["/access/"] }) });
  withAnswers(h.fs, FULL);
  assert.equal(await runYes(h), 1);
  assert.deepEqual(h.cf.mutations(), []);
  assert.deepEqual(h.wr.calls, []);
  assert.deepEqual(h.fs.writes, []);
  assert.match(text(h), /\[!!\] Access: Apps and Policies: Edit/);
  assert.match(text(h), /\[ok\] D1: Edit/);
  assert.match(text(h), /Stopped before changing anything/);

  const d1 = makeDeps({ cf: fakeCf({ denied: ["/d1/"] }) });
  withAnswers(d1.fs, { features: [] });
  assert.equal(await runYes(d1), 1);
  assert.deepEqual(d1.cf.mutations(), []);
  assert.match(text(d1), /\[!!\] D1: Edit/);
});

// ---------- dry run ----------
test("dry run performs no API calls, wrangler calls or writes", async () => {
  const h = makeDeps({
    createCloudflare: () => assert.fail("no Cloudflare client in dry run"),
    createWrangler: () => assert.fail("no wrangler in dry run"),
    fetch: () => assert.fail("no network in dry run"),
    env: { CLOUDFLARE_API_TOKEN: "" },
  });
  withAnswers(h.fs, FULL);
  assert.equal(await runYes(h, ["--dry-run"]), 0);
  assert.deepEqual(h.fs.writes, []);
  const out = text(h);
  for (const name of ["linekeep-api-production", "linekeep-production", "linekeep-recordings-production", "Linekeep production admin"]) {
    assert.ok(out.includes(name), name);
  }
  assert.match(out, /skip|no REST probes/i);
  assert.match(out, /Dry run complete/);
  assert.ok(!out.includes(BOSS) && !out.includes(MAILGUN_KEY));
});

// ---------- full run ----------
test("fresh run creates resources in order and leaks no secret", async () => {
  const h = makeDeps();
  withAnswers(h.fs, FULL);
  assert.equal(await runYes(h), 0, text(h));
  assert.deepEqual(h.cf.mutations(), ["createD1", "createBucket", "createOneTimePin", "createAccessPolicy", "createAccessApp"]);
  assert.deepEqual(h.wr.calls, ["migrate", "deploy", "secretNames", "putSecrets", "deploy"]);
  const [{ env, values }] = h.wr.puts;
  assert.equal(env, "production");
  assert.deepEqual(Object.keys(values).sort(), ["EMAIL_IDS", "MAILGUN_API_KEY", "MAILGUN_DOMAIN", "MAILGUN_REGION", "TOKEN_HASH_SECRET"]);
  assert.equal(values.TOKEN_HASH_SECRET, HASH);
  assert.equal(values.MAILGUN_API_KEY, MAILGUN_KEY);

  const app = h.cf.state.apps[0];
  assert.equal(app.name, "Linekeep production admin");
  assert.deepEqual(app.destinations.map((d) => d.uri), [
    "linekeep-api-production.me.workers.dev/admin", "linekeep-api-production.me.workers.dev/admin/*",
    "linekeep-api-production.me.workers.dev/v1/admin", "linekeep-api-production.me.workers.dev/v1/admin/*",
  ]);
  assert.deepEqual(h.cf.state.policies.p1.include, [{ email: { email: ADMIN } }]);

  const written = h.fs.map.get("wrangler.jsonc");
  const cfg = strip(written);
  assert.equal(cfg.env.production.vars.ACCESS_AUDIENCE, "aud-123");
  assert.equal(cfg.env.production.vars.ACCESS_TEAM_DOMAIN, "https://team.cloudflareaccess.com");
  assert.equal(cfg.env.production.d1_databases[0].database_id, "d1-new-id");
  assert.deepEqual(cfg.env.production.triggers.crons, [DEFAULT_CRON]);

  const everything = `${text(h)}\n${written}`;
  for (const secret of [TOKEN, MAILGUN_KEY, HASH, BOSS, ADMIN]) assert.ok(!everything.includes(secret), `leaked ${secret.slice(0, 8)}`);
  assert.match(text(h), /Secrets set \(names only\): .*TOKEN_HASH_SECRET/);
  assert.match(text(h), /gradlew assembleRelease/);
  assert.match(text(h), /revoke this API token/);
});

test("re-run reuses existing resources and creates nothing", async () => {
  const first = makeDeps();
  withAnswers(first.fs, FULL);
  assert.equal(await runYes(first), 0);

  const cf = fakeCf({
    d1: { id: "d1-new-id", name: "linekeep-production" }, bucket: { name: "linekeep-recordings-production" },
    idps: [{ type: "onetimepin" }], apps: first.cf.state.apps, policies: first.cf.state.policies,
  });
  const wr = fakeWrangler({ secrets: ["TOKEN_HASH_SECRET", "MAILGUN_API_KEY"] });
  const h = makeDeps({ cf, wrangler: wr, fs: first.fs });
  assert.equal(await runYes(h), 0, text(h));
  assert.deepEqual(cf.mutations(), []);
  assert.match(text(h), /Created:\s+server\/wrangler\.jsonc/);
  assert.match(text(h), /Reused:.*D1 database linekeep-production.*R2 bucket/s);
  assert.ok(!("TOKEN_HASH_SECRET" in wr.puts[0].values), "existing hashing secret must never be regenerated");
  assert.ok(first.fs.writes.some((p) => p.endsWith(".bak")), "existing config is backed up");
});

test("hashing secret is neither regenerated nor guessed", async () => {
  const exists = makeDeps({ wrangler: fakeWrangler({ secrets: ["TOKEN_HASH_SECRET"] }) });
  withAnswers(exists.fs, { features: [] });
  assert.equal(await runYes(exists), 0);
  assert.equal(exists.wr.puts.length, 0, "nothing to set");

  const unknown = makeDeps();
  unknown.wr.secretNames = async () => null;
  withAnswers(unknown.fs, { features: [] });
  assert.equal(await runYes(unknown), 1);
  assert.equal(unknown.wr.puts.length, 0);
  assert.match(text(unknown), /Refusing to set TOKEN_HASH_SECRET/);
  assert.match(text(unknown), /Completed before the failure: .*deploy/);
});

test("existing wrangler.jsonc is backed up and other environments survive", async () => {
  const old = '{ // mine\n "name": "x", "env": { "dev": { "name": "dev-worker" }, "production": { "name": "old" } } }';
  const h = makeDeps({ fs: fakeFs({ "wrangler.jsonc": old }) });
  withAnswers(h.fs, { features: [] });
  assert.equal(await runYes(h), 0);
  const backup = [...h.fs.map.keys()].find((k) => k.startsWith("wrangler.jsonc.") && k.endsWith(".bak"));
  assert.equal(backup, "wrangler.jsonc.20260102T030405Z.bak");
  assert.equal(h.fs.map.get(backup), old);
  const cfg = strip(h.fs.map.get("wrangler.jsonc"));
  assert.equal(cfg.env.dev.name, "dev-worker");
  assert.equal(cfg.env.production.name, "linekeep-api-production");
  assert.ok(h.fs.writes.indexOf(backup) < h.fs.writes.indexOf("wrangler.jsonc"));

  const declined = makeDeps({ fs: fakeFs({ "wrangler.jsonc": old }), confirm: async () => false });
  withAnswers(declined.fs, { features: [] });
  assert.equal(await run(["--answers", "answers.json"], declined.deps), 1);
  assert.deepEqual(declined.cf.mutations(), []);
  assert.equal(declined.fs.map.get("wrangler.jsonc"), old);
});

test("without Access the report warns loudly and Access APIs are untouched", async () => {
  const h = makeDeps();
  withAnswers(h.fs, { features: [] });
  assert.equal(await runYes(h), 0);
  assert.ok(!h.cf.calls.some((c) => /Access|Organization|Identity/.test(c.name)));
  assert.match(text(h), /ADMIN PROTECTION IS OFF/);
  assert.deepEqual(Object.keys(strip(h.fs.map.get("wrangler.jsonc")).env.production.vars).filter((k) => k.startsWith("ACCESS")), []);
});

test("Access policy diff is applied only with consent", async () => {
  const mk = () => {
    const policies = { p9: { id: "p9", name: "Linekeep production admins", decision: "allow", include: [{ email: { email: "old@example.com" } }, { email_domain: { domain: "corp.com" } }] } };
    const apps = [{ id: "a9", name: "Linekeep production admin", aud: "aud-9", destinations: [], policies: [{ id: "p9", name: "Linekeep production admins", decision: "allow" }] }];
    return fakeCf({ d1: { id: "d", name: "linekeep-production" }, bucket: { name: "linekeep-recordings-production" }, idps: [{ type: "onetimepin" }], apps, policies });
  };
  const yes = makeDeps({ cf: mk(), wrangler: fakeWrangler({ secrets: ["TOKEN_HASH_SECRET"] }) });
  withAnswers(yes.fs, { features: ["access"], access: { emails: [ADMIN] } });
  assert.equal(await runYes(yes), 0, text(yes));
  assert.deepEqual(yes.cf.mutations(), ["updateAccessPolicy"]);
  assert.deepEqual(yes.cf.state.policies.p9.include, [{ email_domain: { domain: "corp.com" } }, { email: { email: ADMIN } }]);
  assert.ok(!text(yes).includes(ADMIN) && !text(yes).includes("old@example.com"), "emails are masked");
  assert.match(text(yes), /\+ o\*\*\*@example\.com/);
  assert.equal(strip(yes.fs.map.get("wrangler.jsonc")).env.production.vars.ACCESS_AUDIENCE, "aud-9");

  const no = makeDeps({
    cf: mk(), wrangler: fakeWrangler({ secrets: ["TOKEN_HASH_SECRET"] }), confirm: async (q) => !/Update the policy/.test(q),
    ui: { ask: async (_q, { default: d, parse }) => parse(String(d)).value },
  });
  withAnswers(no.fs, { features: ["access"], access: { emails: [ADMIN] } });
  assert.equal(await run(["--answers", "answers.json"], no.deps), 0, text(no));
  assert.deepEqual(no.cf.mutations(), []);
});

test("public bucket is never accepted silently", async () => {
  const exposed = makeDeps({ cf: fakeCf({ bucket: { name: "linekeep-recordings-production" }, exposure: { managedEnabled: true, customDomains: [] } }) });
  withAnswers(exposed.fs, { features: [] });
  assert.equal(await runYes(exposed), 1);
  assert.match(text(exposed), /public r2\.dev URL ENABLED/);
  assert.ok(!exposed.cf.mutations().includes("disableManagedDomain"), "--yes never flips settings on an existing bucket");
  assert.deepEqual(exposed.wr.calls, []);

  const custom = makeDeps({ cf: fakeCf({ bucket: { name: "linekeep-recordings-production" }, exposure: { managedEnabled: false, customDomains: ["files.example.com"] } }) });
  withAnswers(custom.fs, { features: [] });
  assert.equal(await runYes(custom), 1);
  assert.match(text(custom), /custom domain/);
});

test("failed verification and secrets in answers file are errors", async () => {
  const bad = makeDeps({ fetch: async (url) => (url.includes("/health") ? response(500) : response(200)) });
  withAnswers(bad.fs, { features: [] });
  assert.equal(await runYes(bad), 1);
  assert.match(text(bad), /Verification failed/);

  for (const bad2 of [{ apiToken: TOKEN }, { email: { apiKey: MAILGUN_KEY }, features: ["email"] }]) {
    const h = makeDeps();
    withAnswers(h.fs, bad2);
    assert.equal(await runYes(h), 1);
    assert.deepEqual(h.cf.mutations(), []);
    assert.ok(!text(h).includes(TOKEN) && !text(h).includes(MAILGUN_KEY));
  }
});

test("prerequisites and missing answers fail clearly", async () => {
  const old = makeDeps();
  old.deps.nodeVersion = "20.11.0";
  assert.equal(await run([], old.deps), 1);
  assert.match(text(old), /Node\.js 22/);

  const noWrangler = makeDeps({ fs: fakeFs() });
  noWrangler.fs.map.delete(WRANGLER_ENTRY);
  assert.equal(await run([], noWrangler.deps), 1);
  assert.match(text(noWrangler), /npm ci/);

  const missing = makeDeps();
  withAnswers(missing.fs, { features: ["access"] });
  assert.equal(await runYes(missing), 1);
  assert.match(text(missing), /access\.emails/);
  assert.deepEqual(missing.cf.mutations(), []);

  const usage = makeDeps();
  assert.equal(await run(["--nope"], usage.deps), 2);
  assert.equal(await run(["--help"], usage.deps), 0);
});

// ---------- WhatsApp and push notifications ----------
const WA_TOKEN = "EAAGsystemUserTOKEN1234567890";
const WA_SECRET = "synthetic-whatsapp-app-secret-for-tests";
const VERIFY = "ab".repeat(24); // makeDeps().randomHex(24)
const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nTOPSECRETKEYMATERIAL\n-----END PRIVATE KEY-----\n";
const SERVICE_ACCOUNT = JSON.stringify({ type: "service_account", project_id: "linekeep-demo", client_email: "fcm@linekeep-demo.iam.gserviceaccount.com", private_key: PRIVATE_KEY });
const API_KEY = "AIzaSyDUMMYDUMMYDUMMYDUMMY123456";
const googleServices = (over = {}) => JSON.stringify({
  project_info: { project_number: "123456789012", project_id: "linekeep-demo" },
  client: [
    { client_info: { mobilesdk_app_id: "1:123456789012:android:other000", android_client_info: { package_name: "com.example.other" } }, api_key: [{ current_key: "AIzaOTHEROTHEROTHEROTHER12345" }] },
    { client_info: { mobilesdk_app_id: "1:123456789012:android:abcdef0123", android_client_info: { package_name: "com.microorganics.calltracker" } }, api_key: [{ current_key: API_KEY }] },
  ],
  ...over,
});
const WA_FILE = { phoneNumberId: "123456789", wabaId: "987654321", appId: "555555555" };
const FILES = { "/k/sa.json": SERVICE_ACCOUNT, "/k/gs.json": googleServices() };
const PUSH_FILE = { serviceAccountFile: "/k/sa.json", googleServicesFile: "/k/gs.json" };
const BOTH = { features: ["whatsapp", "push"], whatsapp: WA_FILE, push: PUSH_FILE };
const SECRET_ENV = { WHATSAPP_TOKEN: WA_TOKEN, WHATSAPP_APP_SECRET: WA_SECRET };

function graphFetch(graph = []) {
  return async (url, init) => {
    if (String(url).startsWith("https://graph.facebook.com/")) {
      graph.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    if (url.includes("/health")) return response(200);
    if (url.includes("/v1/device/customers")) return response(401);
    return response(200);
  };
}
const waDeps = (over = {}) => makeDeps({ fs: fakeFs(FILES), env: SECRET_ENV, ...over });
const noLeak = (h, extra = []) => {
  const everything = `${text(h)}\n${h.fs.map.get("wrangler.jsonc") ?? ""}`;
  for (const secret of [TOKEN, WA_TOKEN, WA_SECRET, VERIFY, PRIVATE_KEY, "TOPSECRETKEYMATERIAL", SERVICE_ACCOUNT, ...extra]) {
    assert.ok(!everything.includes(secret), `leaked ${secret.slice(0, 10)}`);
  }
};

test("WhatsApp id and credential validation", () => {
  assert.equal(parseMetaId(" 123456789012345 ").value, "123456789012345");
  for (const bad of ["1234", "x12345", "1234 56789", "", "1".repeat(33), "12.5e4"]) assert.equal(parseMetaId(bad).ok, false, bad);
  assert.equal(parseCredential(WA_TOKEN).value, WA_TOKEN);
  for (const bad of ["", "   ", "has space", "line\nbreak", "x".repeat(5000)]) {
    const r = parseCredential(bad, "access token");
    assert.equal(r.ok, false);
    assert.ok(!r.error.includes("has space"), "the value is never echoed");
  }
});

test("service account and google-services.json parsing", () => {
  const sa = parseServiceAccount(SERVICE_ACCOUNT);
  assert.equal(sa.ok, true);
  assert.equal(sa.value.projectId, "linekeep-demo");
  assert.deepEqual(JSON.parse(sa.value.json).client_email, "fcm@linekeep-demo.iam.gserviceaccount.com");
  for (const missing of ["client_email", "private_key", "project_id"]) {
    const broken = { ...JSON.parse(SERVICE_ACCOUNT) };
    delete broken[missing];
    const r = parseServiceAccount(JSON.stringify(broken));
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(missing));
  }
  const garbage = parseServiceAccount('{"private_key": "TOPSECRETKEYMATERIAL" oops');
  assert.equal(garbage.ok, false);
  assert.ok(!garbage.error.includes("TOPSECRET"), "parse errors never quote the file");
  assert.equal(parseServiceAccount(JSON.stringify({ ...JSON.parse(SERVICE_ACCOUNT), private_key: "not a pem" })).ok, false);

  const gs = parseGoogleServices(googleServices());
  assert.deepEqual(gs.value, { apiKey: API_KEY, appId: "1:123456789012:android:abcdef0123", projectId: "linekeep-demo", senderId: "123456789012" });
  const wrongPackage = parseGoogleServices(JSON.stringify({ ...JSON.parse(googleServices()), client: [JSON.parse(googleServices()).client[0]] }));
  assert.equal(wrongPackage.ok, false);
  assert.match(wrongPackage.error, /com\.microorganics\.calltracker/);
  assert.equal(parseGoogleServices("nope").ok, false);
  assert.equal(parseFirebaseField("senderId", 123456789012).ok, true);
  for (const [k, v] of [["apiKey", "short"], ["appId", "1:2:ios:ab"], ["projectId", "A"], ["senderId", "12"]]) assert.equal(parseFirebaseField(k, v).ok, false, k);
});

test("answers file never carries WhatsApp or push secrets", async () => {
  for (const file of [
    { whatsappToken: WA_TOKEN }, { whatsapp: { token: WA_TOKEN } }, { whatsapp: { accessToken: WA_TOKEN } },
    { whatsapp: { appSecret: WA_SECRET } }, { whatsapp: { verifyToken: VERIFY } }, { push: { serviceAccount: SERVICE_ACCOUNT } },
    { push: { privateKey: PRIVATE_KEY } },
  ]) assert.throws(() => assertNoSecretsInAnswers(file), /Refusing/, JSON.stringify(file).slice(0, 40));
  assert.doesNotThrow(() => assertNoSecretsInAnswers(BOTH));

  for (const file of [{ features: [], whatsapp: { appSecret: WA_SECRET } }, { features: [], push: { serviceAccount: SERVICE_ACCOUNT } }]) {
    const h = waDeps();
    withAnswers(h.fs, file);
    assert.equal(await runYes(h), 1);
    assert.deepEqual(h.cf.mutations(), []);
    assert.match(text(h), /Refusing/);
    noLeak(h);
  }
});

test("WhatsApp answers: ids validated, secrets only from the environment, missing values are named", async () => {
  const badId = waDeps();
  withAnswers(badId.fs, { features: ["whatsapp"], whatsapp: { ...WA_FILE, wabaId: "12ab" } });
  assert.equal(await runYes(badId), 1);
  assert.match(text(badId), /whatsapp\.wabaId.*5-32 digits/);
  assert.deepEqual(badId.cf.mutations(), []);

  const noEnv = waDeps({ env: {} });
  withAnswers(noEnv.fs, { features: ["whatsapp"], whatsapp: WA_FILE });
  assert.equal(await runYes(noEnv), 1);
  assert.match(text(noEnv), /WHATSAPP_TOKEN environment variable/);

  const noSecret = waDeps({ env: { WHATSAPP_TOKEN: WA_TOKEN } });
  withAnswers(noSecret.fs, { features: ["whatsapp"], whatsapp: WA_FILE });
  assert.equal(await runYes(noSecret), 1);
  assert.match(text(noSecret), /WHATSAPP_APP_SECRET environment variable/);

  const missingId = waDeps();
  withAnswers(missingId.fs, { features: ["whatsapp"], whatsapp: { phoneNumberId: "123456789" } });
  assert.equal(await runYes(missingId), 1);
  assert.match(text(missingId), /whatsapp\.wabaId/);

  const spaced = waDeps({ env: { WHATSAPP_TOKEN: "has a space", WHATSAPP_APP_SECRET: WA_SECRET } });
  withAnswers(spaced.fs, { features: ["whatsapp"], whatsapp: WA_FILE });
  assert.equal(await runYes(spaced), 1);
  assert.match(text(spaced), /WHATSAPP_TOKEN is set but invalid/);
  assert.ok(!text(spaced).includes("has a space"));
});

test("push answers: files are validated and the project must match", async () => {
  const missingFile = waDeps();
  withAnswers(missingFile.fs, { features: ["push"], push: { serviceAccountFile: "/k/none.json", googleServicesFile: "/k/gs.json" } });
  assert.equal(await runYes(missingFile), 1);
  assert.match(text(missingFile), /Could not read "\/k\/none\.json"/);

  const mismatch = waDeps({ fs: fakeFs({ ...FILES, "/k/gs.json": googleServices({ project_info: { project_number: "123456789012", project_id: "other-project" } }) }) });
  withAnswers(mismatch.fs, { features: ["push"], push: PUSH_FILE });
  assert.equal(await runYes(mismatch), 1);
  assert.match(text(mismatch), /same Firebase project/);
  noLeak(mismatch);

  const noClient = waDeps();
  withAnswers(noClient.fs, { features: ["push"], push: { serviceAccountFile: "/k/sa.json" } });
  assert.equal(await runYes(noClient), 1);
  assert.match(text(noClient), /push\.googleServicesFile/);

  const manual = waDeps();
  withAnswers(manual.fs, { features: ["push"], push: { serviceAccountFile: "/k/sa.json", apiKey: API_KEY, appId: "1:123456789012:android:abcdef0123", projectId: "linekeep-demo", senderId: "123456789012" } });
  assert.equal(await runYes(manual), 0, text(manual));
  assert.equal(manual.wr.puts[0].values.FIREBASE_CLIENT_CONFIG, JSON.stringify({ apiKey: API_KEY, appId: "1:123456789012:android:abcdef0123", projectId: "linekeep-demo", senderId: "123456789012" }));
});

test("Meta call construction is pure and keeps secrets out of descriptions", () => {
  const callbackUrl = webhookUrl("https://w.me.workers.dev/");
  assert.equal(callbackUrl, "https://w.me.workers.dev/v1/webhooks/whatsapp");
  const [subscription, subscribed] = buildMetaCalls({ appId: "555555555", wabaId: "987654321", callbackUrl, verifyToken: VERIFY, appSecret: WA_SECRET, accessToken: WA_TOKEN });
  assert.equal(subscription.method, "POST");
  assert.equal(subscription.url, "https://graph.facebook.com/v23.0/555555555/subscriptions");
  assert.ok(!subscription.url.includes(WA_SECRET), "secrets are in the body, never the URL");
  const form = new URLSearchParams(subscription.body);
  assert.deepEqual(Object.fromEntries(form), {
    object: "whatsapp_business_account", callback_url: callbackUrl, verify_token: VERIFY, fields: "messages", access_token: `555555555|${WA_SECRET}`,
  });
  assert.equal(subscribed.url, "https://graph.facebook.com/v23.0/987654321/subscribed_apps");
  assert.equal(subscribed.headers.Authorization, `Bearer ${WA_TOKEN}`);

  const described = describeMetaCalls({ appId: "555555555", wabaId: "987654321", callbackUrl }).join("\n");
  for (const secret of [VERIFY, WA_SECRET, WA_TOKEN]) assert.ok(!described.includes(secret));
  for (const placeholder of Object.values(PLACEHOLDERS)) assert.ok(described.includes(placeholder), placeholder);
  assert.match(described, /POST https:\/\/graph\.facebook\.com\/v23\.0\/555555555\/subscriptions/);
});

test("registerWebhook reports Meta errors without request contents", async () => {
  const calls = buildMetaCalls({ appId: "555555555", wabaId: "987654321", callbackUrl: "https://w/x", verifyToken: VERIFY, appSecret: WA_SECRET, accessToken: WA_TOKEN });
  const rejected = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "Callback verification failed", code: 100 } }) });
  await assert.rejects(registerWebhook(rejected, calls), (e) => /Callback verification failed \(code 100\)/.test(e.message) && !e.message.includes(WA_SECRET) && !e.message.includes(VERIFY));
  await assert.rejects(registerWebhook(async () => { throw new Error(`boom ${WA_SECRET}`); }, calls), (e) => !e.message.includes(WA_SECRET));
});

test("dry run lists the new secrets and the Meta calls, with no network and no secret values", async () => {
  const h = makeDeps({
    fs: fakeFs(FILES), env: { CLOUDFLARE_API_TOKEN: "", ...SECRET_ENV },
    createCloudflare: () => assert.fail("no Cloudflare client in dry run"),
    createWrangler: () => assert.fail("no wrangler in dry run"),
    fetch: () => assert.fail("no network in dry run"),
  });
  withAnswers(h.fs, { ...BOTH, subdomain: "me" });
  assert.equal(await runYes(h, ["--dry-run"]), 0, text(h));
  const out = text(h);
  for (const name of ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_WABA_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "FCM_SERVICE_ACCOUNT", "FIREBASE_CLIENT_CONFIG"]) {
    assert.ok(out.includes(`secret: ${name}`), name);
  }
  assert.match(out, /Meta developer account and a Business app/);
  assert.match(out, /Live mode/);
  assert.match(out, /Firebase Cloud Messaging API Admin role/);
  assert.match(out, /POST https:\/\/graph\.facebook\.com\/v23\.0\/555555555\/subscriptions/);
  assert.match(out, /POST https:\/\/graph\.facebook\.com\/v23\.0\/987654321\/subscribed_apps/);
  assert.match(out, /callback_url=https:\/\/linekeep-api-production\.me\.workers\.dev\/v1\/webhooks\/whatsapp/);
  assert.deepEqual(h.fs.writes, []);
  noLeak(h);
  assert.ok(!out.includes(API_KEY));

  const plan = buildPlan({ ...base({}), features: { access: false, email: false, retention: false, whatsapp: true, push: true }, whatsapp: { ...WA_FILE }, push: { projectId: "linekeep-demo" } });
  assert.deepEqual(plan.map((s) => s.id), ["subdomain", "d1", "r2", "config", "migrate", "deploy", "secrets", "verify", "whatsapp"]);
  assert.match(describeAnswers({ ...base({}), features: { whatsapp: true, push: true }, push: { projectId: "linekeep-demo" } }).join("\n"), /Firebase project linekeep-demo/);
});

test("permissions stay unchanged: WhatsApp and push secrets use Workers Scripts: Edit", () => {
  assert.deepEqual(requiredPermissions(["whatsapp", "push"]).map((p) => p.label), requiredPermissions([]).map((p) => p.label));
});

test("declining 'Set up WhatsApp now?' skips every WhatsApp prompt and plan entry", async () => {
  const asked = [];
  const h = makeDeps({
    fs: fakeFs(FILES),
    ui: {
      multiselect: async () => ["whatsapp", "push"],
      ask: async (q, { default: d, parse }) => {
        asked.push(q);
        return parse(String(d)).value;
      },
      confirm: async (q) => {
        asked.push(q);
        return false;
      },
    },
  });
  assert.equal(await run(["--dry-run"], h.deps), 0, text(h));
  assert.ok(asked.some((q) => /Set up WhatsApp now\?/.test(q)));
  assert.ok(asked.some((q) => /Set up push notifications now\?/.test(q)));
  assert.ok(!asked.some((q) => /Phone number ID|Meta App ID|service-account/.test(q)));
  assert.match(text(h), /WhatsApp Business:\s+off/);
  assert.ok(!text(h).includes("secret: WHATSAPP_TOKEN"));
  assert.match(text(h), /Meta developer account/, "prerequisites are still shown first");
});

test("fresh run sets the new secrets, generates the verify token and registers the webhook", async () => {
  const graph = [];
  const h = waDeps({ fetch: graphFetch(graph) });
  withAnswers(h.fs, { ...BOTH, whatsapp: { ...WA_FILE, registerWebhook: true } });
  assert.equal(await runYes(h), 0, text(h));
  assert.deepEqual(h.wr.calls, ["migrate", "deploy", "secretNames", "putSecrets"]);
  const { values } = h.wr.puts[0];
  assert.deepEqual(Object.keys(values).sort(), [
    "FCM_SERVICE_ACCOUNT", "FIREBASE_CLIENT_CONFIG", "TOKEN_HASH_SECRET", "WHATSAPP_APP_SECRET", "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_TOKEN", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_WABA_ID",
  ]);
  assert.equal(values.WHATSAPP_TOKEN, WA_TOKEN);
  assert.equal(values.WHATSAPP_APP_SECRET, WA_SECRET);
  assert.equal(values.WHATSAPP_PHONE_NUMBER_ID, "123456789");
  assert.equal(values.WHATSAPP_WABA_ID, "987654321");
  assert.equal(values.WHATSAPP_VERIFY_TOKEN, VERIFY);
  assert.equal(JSON.parse(values.FCM_SERVICE_ACCOUNT).project_id, "linekeep-demo");
  assert.deepEqual(JSON.parse(values.FIREBASE_CLIENT_CONFIG), { apiKey: API_KEY, appId: "1:123456789012:android:abcdef0123", projectId: "linekeep-demo", senderId: "123456789012" });

  assert.equal(graph.length, 2);
  assert.equal(graph[0].url, "https://graph.facebook.com/v23.0/555555555/subscriptions");
  assert.equal(graph[0].init.method, "POST");
  const form = new URLSearchParams(graph[0].init.body);
  assert.equal(form.get("verify_token"), VERIFY);
  assert.equal(form.get("access_token"), `555555555|${WA_SECRET}`);
  assert.equal(form.get("callback_url"), "https://linekeep-api-production.me.workers.dev/v1/webhooks/whatsapp");
  assert.equal(graph[1].url, "https://graph.facebook.com/v23.0/987654321/subscribed_apps");
  assert.equal(graph[1].init.headers.Authorization, `Bearer ${WA_TOKEN}`);

  assert.match(text(h), /Secrets set \(names only\):.*WHATSAPP_VERIFY_TOKEN/);
  assert.match(text(h), /\[x\] Webhook registered/);
  assert.match(text(h), /Live mode/);
  assert.match(text(h), /payment method/);
  assert.match(text(h), /Push notifications: ready for Firebase project linekeep-demo/);
  noLeak(h, [API_KEY]);
});

test("existing verify token is kept; declining registration prints instructions but never the token", async () => {
  const graph = [];
  const h = waDeps({ fetch: graphFetch(graph), wrangler: fakeWrangler({ secrets: ["TOKEN_HASH_SECRET", "WHATSAPP_VERIFY_TOKEN"] }) });
  withAnswers(h.fs, { features: ["whatsapp"], whatsapp: { ...WA_FILE, registerWebhook: true } });
  assert.equal(await runYes(h), 0, text(h));
  assert.ok(!("WHATSAPP_VERIFY_TOKEN" in h.wr.puts[0].values), "an existing verify token is never regenerated implicitly");
  assert.equal(h.wr.puts.length, 1, "no replacement without consent");
  assert.equal(graph.length, 0, "cannot register without knowing the token");
  assert.match(text(h), /Reused:.*WHATSAPP_VERIFY_TOKEN/);
  assert.match(text(h), /npx wrangler secret put WHATSAPP_VERIFY_TOKEN --env production/);
  assert.match(text(h), /Callback URL:\s+https:\/\/linekeep-api-production\.me\.workers\.dev\/v1\/webhooks\/whatsapp/);
  assert.match(text(h), /\[ \] Register the webhook/);
  noLeak(h);

  const declined = waDeps({ fetch: graphFetch(graph) });
  withAnswers(declined.fs, { features: ["whatsapp"], whatsapp: WA_FILE });
  assert.equal(await runYes(declined), 0, text(declined));
  assert.equal(graph.length, 0);
  assert.equal(declined.wr.puts[0].values.WHATSAPP_VERIFY_TOKEN, VERIFY, "first run still generates and stores one");
  assert.match(text(declined), /never shown/);
  noLeak(declined);
});

test("replacing the verify token needs consent and then registers", async () => {
  const graph = [];
  const h = waDeps({ fetch: graphFetch(graph), wrangler: fakeWrangler({ secrets: ["TOKEN_HASH_SECRET", "WHATSAPP_VERIFY_TOKEN"] }) });
  withAnswers(h.fs, { features: ["whatsapp"], whatsapp: { ...WA_FILE, registerWebhook: true, replaceVerifyToken: true } });
  assert.equal(await runYes(h), 0, text(h));
  assert.equal(h.wr.puts.length, 2);
  assert.deepEqual(h.wr.puts[1].values, { WHATSAPP_VERIFY_TOKEN: VERIFY });
  assert.equal(new URLSearchParams(graph[0].init.body).get("verify_token"), VERIFY);
  assert.match(text(h), /WHATSAPP_VERIFY_TOKEN \(replaced\)/);
  noLeak(h);
});

test("a rejected Meta registration is reported without failing the deployment or leaking secrets", async () => {
  const h = waDeps({
    fetch: async (url) => (String(url).startsWith("https://graph.facebook.com/")
      ? { ok: false, status: 400, json: async () => ({ error: { message: `bad ${WA_SECRET}`, code: 100 } }) }
      : url.includes("/v1/device/customers") ? response(401) : response(200)),
  });
  withAnswers(h.fs, { features: ["whatsapp"], whatsapp: { ...WA_FILE, registerWebhook: true } });
  assert.equal(await runYes(h), 0, text(h));
  assert.match(text(h), /Could not register the webhook/);
  assert.match(text(h), /\[ \] Register the webhook/);
  noLeak(h);
});
