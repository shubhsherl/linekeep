import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "./setup/args.mjs";
import { backupName, buildWranglerConfig, DEFAULT_CRON, parseJsonc, renderWranglerConfig } from "./setup/config.mjs";
import { probePermissions, requiredPermissions } from "./setup/permissions.mjs";
import { buildPlan, describeAnswers } from "./setup/plan.mjs";
import { run } from "./setup/run.mjs";
import {
  cronToIst, istTimeToCron, parseBucketName, parseCron, parseD1Name, parseDays, parseDomain, parseEmail, parseEmailList,
  parseEnvName, parseMegabytes, parseSessionDuration, parseWorkerName,
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
  assert.equal(parseCron("30 12 * * *").ok, true);
  assert.equal(parseCron("*/15 0-6 1,15 JAN-MAR MON").ok, true);
  for (const bad of ["30 12 * *", "60 12 * * *", "30 24 * * *", "a b c d e", "*/0 * * * *", "1 2 3 4 5 6"]) assert.equal(parseCron(bad).ok, false, bad);
  assert.equal(istTimeToCron("18:00").value, DEFAULT_CRON);
  assert.equal(istTimeToCron("00:00").value, "30 18 * * *");
  assert.equal(istTimeToCron("5:15").value, "45 23 * * *");
  assert.equal(istTimeToCron("25:00").ok, false);
  assert.equal(cronToIst("30 12 * * *"), "18:00");
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
  access: { emails: [ADMIN], sessionDuration: "1h", oneTimePin: true }, email: { domain: "mg.example.com", region: "us", cron: DEFAULT_CRON, recipients: [BOSS], from: null },
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
