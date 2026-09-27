import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";

// These tools are supplied by the pinned Wrangler installation; no second test toolchain.
export async function loadModule(relativePath) {
  const directory = await mkdtemp(join(tmpdir(), "calltracker-module-"));
  try {
    const outfile = join(directory, "module.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      outfile,
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function createDatabase(context, throughMigration) {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "repository-tests",
          compatibilityDate: "2026-09-24",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents:
                  "export default { fetch() { return new Response(null, { status: 404 }); } }",
              },
            },
          },
          env: { DB: { type: "d1", id: "test-db" } },
        },
      },
    ],
  });
  context.after(() => runtime.dispose());
  const db = await runtime.getD1Database("DB");
  const migrations = new URL("../../migrations/", import.meta.url);
  for (const name of (await readdir(migrations))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    if (throughMigration && name > throughMigration) break;
    const statements = unstable_splitSqlQuery(
      await readFile(new URL(name, migrations), "utf8"),
    );
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
  return db;
}
