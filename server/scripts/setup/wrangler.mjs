import { spawn } from "node:child_process";
import { join } from "node:path";

export const WRANGLER_ENTRY = join("node_modules", "wrangler", "bin", "wrangler.js");

/** Replace every registered secret value in text. */
export function createMasker() {
  const values = new Set();
  return {
    add(value) {
      if (typeof value === "string" && value.length >= 4) values.add(value);
    },
    mask(text) {
      let out = String(text ?? "");
      for (const v of values) out = out.split(v).join("********");
      return out;
    },
  };
}

/**
 * Wrangler wrapper. Credentials reach the child only through its environment; secret values only through stdin.
 * `spawnImpl` is injectable for tests.
 */
export function createWrangler({ cwd, token, accountId, masker = createMasker(), spawnImpl = spawn, baseEnv = process.env }) {
  masker.add(token);
  const env = {
    ...baseEnv,
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CI: "1", // no interactive confirmations
    WRANGLER_SEND_METRICS: "false",
    NO_COLOR: "1",
  };
  if (!token) delete env.CLOUDFLARE_API_TOKEN;
  if (!accountId) delete env.CLOUDFLARE_ACCOUNT_ID;

  /** Resolves { code, stdout, stderr } with secrets masked. `input` is written to stdin. */
  function run(args, { input } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawnImpl(process.execPath, [WRANGLER_ENTRY, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (e) => reject(new Error(`Could not start wrangler: ${e.message}`)));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout: masker.mask(stdout), stderr: masker.mask(stderr) }));
      child.stdin.on("error", () => {});
      child.stdin.end(input ?? "");
    });
  }

  async function mustRun(args, options) {
    const r = await run(args, options);
    if (r.code !== 0) {
      const tail = `${r.stderr}\n${r.stdout}`.trim().split("\n").slice(-15).join("\n");
      throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed (exit ${r.code}):\n${tail}`);
    }
    return r;
  }

  return {
    run,
    mustRun,
    masker,
    async secretNames(env) {
      const r = await run(["secret", "list", "--env", env, "--format", "json"]);
      if (r.code !== 0) return null; // Worker does not exist yet (or unreadable)
      try {
        const start = r.stdout.indexOf("[");
        return JSON.parse(r.stdout.slice(start)).map((s) => s.name);
      } catch {
        return null;
      }
    },
    /** Secrets travel as JSON on stdin only. */
    putSecrets(env, secrets) {
      for (const v of Object.values(secrets)) masker.add(v);
      return mustRun(["secret", "bulk", "--env", env], { input: JSON.stringify(secrets) });
    },
    migrate: (env) => mustRun(["d1", "migrations", "apply", "DB", "--env", env, "--remote"]),
    async deploy(env) {
      const r = await mustRun(["deploy", "--env", env]);
      const url = /https:\/\/[A-Za-z0-9.-]+\.workers\.dev/.exec(`${r.stdout}\n${r.stderr}`)?.[0] ?? null;
      return { url, output: r.stdout };
    },
  };
}
