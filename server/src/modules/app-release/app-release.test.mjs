import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";

const adminSecret = "synthetic-app-release-admin-secret-not-for-deployment";
const apkType = "application/vnd.android.package-archive";

// The upload path needs workerd (FixedLengthStream, DigestStream, R2), so the whole app runs inside Miniflare.
const bundle = await build({
  stdin: {
    contents: `
      import { createApp } from '../../app.ts';
      const app = createApp();
      export default { fetch: (request, env, ctx) => app.fetch(request, env, ctx) };
    `,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    sourcefile: "app-release-test-worker.ts",
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
});

/** Zip-like synthetic bytes: the ZIP signature followed by deterministic filler. */
function apk(size, seed = 1) {
  const bytes = new Uint8Array(size);
  let state = seed;
  for (let index = 4; index < size; index++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[index] = state >>> 16;
  }
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  return bytes;
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const runtime = new Miniflare({
    workers: [{
      config: {
        name: "app-release-tests",
        compatibilityDate: "2026-09-24",
        manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: bundle.outputFiles[0].text } } },
        env: {
          DB: { type: "d1", id: "app-release-tests" },
          RECORDINGS: { type: "r2", name: "app-release-tests" },
          ENVIRONMENT: { type: "text", value: "development" },
          LOCAL_ADMIN_SECRET: { type: "text", value: adminSecret },
          MAX_RECORDING_BYTES: { type: "text", value: "1024" },
        },
      },
    }],
  });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("DB");
  const bucket = await runtime.getR2Bucket("RECORDINGS");
  const migrations = new URL("../../../migrations/", import.meta.url);
  for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
    const statements = unstable_splitSqlQuery(await readFile(new URL(name, migrations), "utf8"));
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
  const call = (path, init = {}) => runtime.dispatchFetch(`http://127.0.0.1${path}`, init);
  const admin = (method, path, { body, headers = {} } = {}) =>
    call(path, { method, headers: { Authorization: `Bearer ${adminSecret}`, ...headers }, body, duplex: "half" });
  // Miniflare sends byte bodies chunked unless the length is stated; a phone's browser always states it.
  const upload = (version, bytes, headers = { "Content-Type": apkType }) =>
    admin("PUT", `/v1/admin/app/apk?versionName=${encodeURIComponent(version)}`, {
      body: bytes,
      headers: bytes instanceof Uint8Array ? { "Content-Length": String(bytes.byteLength), ...headers } : headers,
    });
  const share = (publicDownload) =>
    admin("PUT", "/v1/admin/app/sharing", { body: JSON.stringify({ publicDownload }), headers: { "Content-Type": "application/json" } });
  const keys = async () => (await bucket.list({ prefix: "app-releases/" })).objects.map((object) => object.key).sort();
  const state = async () => (await admin("GET", "/v1/admin/app")).json();
  return { runtime, db, bucket, call, admin, upload, share, keys, state };
}

test("upload streams the file to R2 and records its version, size and SHA-256", async (t) => {
  const f = await fixture(t);
  const before = await f.state();
  assert.equal(before.latest, null);
  assert.equal(before.publicDownload, false);
  assert.equal(before.downloadPageUrl, "http://127.0.0.1/download");
  assert.equal(before.apkUrl, "http://127.0.0.1/download/linekeep.apk");

  const bytes = apk(3 * 1024 * 1024 + 17);
  const response = await f.upload("1.0.5", bytes);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.latest.versionName, "1.0.5");
  assert.equal(body.latest.size, bytes.byteLength);
  assert.equal(body.latest.sha256, sha256(bytes));
  assert.equal(body.latest.objectKey, "app-releases/linekeep-1.0.5.apk");
  assert.ok(!Number.isNaN(Date.parse(body.latest.uploadedAt)));
  assert.equal(body.publicDownload, false);

  const stored = await f.bucket.get("app-releases/linekeep-1.0.5.apk");
  assert.equal(stored.httpMetadata.contentType, apkType);
  assert.equal(sha256(new Uint8Array(await stored.arrayBuffer())), sha256(bytes));
  const row = await f.db.prepare("SELECT value FROM app_settings WHERE key = 'app.latest'").first();
  assert.deepEqual(JSON.parse(row.value), body.latest);
  assert.deepEqual((await f.state()).latest, body.latest);
});

test("octet-stream uploads are accepted", async (t) => {
  const f = await fixture(t);
  const response = await f.upload("2.0", apk(4096), { "Content-Type": "application/octet-stream" });
  assert.equal(response.status, 200);
});

test("invalid uploads are rejected and nothing is stored", async (t) => {
  const f = await fixture(t);
  const notZip = apk(4096);
  notZip.set([0x4d, 0x5a, 0x90, 0x00]);
  const cases = [
    ["bad magic", () => f.upload("1.0.0", notZip), 400],
    ["too small", () => f.upload("1.0.0", apk(1023)), 400],
    ["too large", () => f.upload("1.0.0", apk(100 * 1024 * 1024 + 1)), 413],
    ["no content length", () => f.upload("1.0.0", new ReadableStream({ start(c) { c.enqueue(apk(4096)); c.close(); } })), 400],
    ["bad content type", () => f.upload("1.0.0", apk(4096), { "Content-Type": "text/plain" }), 400],
    ["empty version", () => f.upload("", apk(4096)), 400],
    ["path in version", () => f.upload("../x", apk(4096)), 400],
    ["leading dot version", () => f.upload(".1", apk(4096)), 400],
    ["version too long", () => f.upload("1".repeat(33), apk(4096)), 400],
    ["space in version", () => f.upload("1 0", apk(4096)), 400],
  ];
  for (const [name, send, status] of cases) {
    // A server that refuses an oversized body without reading it may reset the connection before the client sees 413.
    const response = await send().catch((error) => (status === 413 ? { status, json: async () => ({}) } : Promise.reject(error)));
    assert.equal(response.status, status, name);
    const body = await response.json().catch(() => ({}));
    if (response.status === 400) assert.equal(body.error?.code, "INVALID_REQUEST", name);
  }
  assert.deepEqual(await f.keys(), []);
  const state = await f.state();
  assert.equal(state.latest, null);
  assert.equal(await f.db.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key LIKE 'app.%'").first("n"), 0);
});

test("a bad file does not replace the current release", async (t) => {
  const f = await fixture(t);
  const good = apk(5000);
  const first = await (await f.upload("1.0.0", good)).json();
  const notZip = apk(5000, 9);
  notZip.set([1, 2, 3, 4]);
  assert.equal((await f.upload("1.0.0", notZip)).status, 400);
  assert.deepEqual((await f.state()).latest, first.latest);
  const stored = await f.bucket.get("app-releases/linekeep-1.0.0.apk");
  assert.equal(sha256(new Uint8Array(await stored.arrayBuffer())), sha256(good));
});

test("public routes answer 404 until sharing is on", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/download")).status, 404);
  assert.equal((await f.call("/download/linekeep.apk")).status, 404);
  await f.upload("1.0.5", apk(5000));
  const page = await f.call("/download");
  assert.equal(page.status, 404);
  assert.ok(!(await page.text()).includes("1.0.5"));
  assert.equal((await f.call("/download/linekeep.apk")).status, 404);
  assert.equal((await f.call("/download/linekeep.apk", { method: "HEAD" })).status, 404);
  assert.equal((await f.share(true)).status, 200);
  assert.equal((await f.call("/download")).status, 200);
  assert.equal((await f.share(false)).status, 200);
  assert.equal((await f.call("/download")).status, 404);
  assert.equal((await f.call("/download/linekeep.apk")).status, 404);
});

test("with sharing on, anyone gets the page and the exact bytes with installer headers", async (t) => {
  const f = await fixture(t);
  const bytes = apk(300_000);
  const { latest } = await (await f.upload("1.0.5", bytes)).json();
  const shared = await (await f.share(true)).json();
  assert.equal(shared.publicDownload, true);

  const page = await f.call("/download");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  assert.doesNotMatch(page.headers.get("content-security-policy"), /script-src|https?:/);
  const html = await page.text();
  assert.ok(html.includes("Linekeep") && html.includes("1.0.5") && html.includes(latest.sha256) && html.includes("/download/linekeep.apk"));
  assert.match(html, /Install unknown apps/);
  assert.doesNotMatch(html, /<script|<link|<img|(?:src|href)=["']?https?:|url\(/i);

  const file = await f.call("/download/linekeep.apk");
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), apkType);
  assert.equal(file.headers.get("content-disposition"), 'attachment; filename="linekeep-1.0.5.apk"');
  assert.equal(file.headers.get("x-content-type-options"), "nosniff");
  assert.equal(file.headers.get("cache-control"), "no-store");
  assert.equal(file.headers.get("content-length"), String(bytes.byteLength));
  assert.equal(sha256(new Uint8Array(await file.arrayBuffer())), sha256(bytes));
});

test("HEAD and byte ranges work on the public download", async (t) => {
  const f = await fixture(t);
  const bytes = apk(10_000);
  await f.upload("1.0.5", bytes);
  await f.share(true);
  const head = await f.call("/download/linekeep.apk", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), apkType);
  assert.equal(head.headers.get("content-length"), String(bytes.byteLength));
  assert.equal(head.headers.get("content-disposition"), 'attachment; filename="linekeep-1.0.5.apk"');
  assert.equal(head.headers.get("cache-control"), "no-store");
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await f.call("/download", { method: "HEAD" })).status, 200);

  const part = await f.call("/download/linekeep.apk", { headers: { Range: "bytes=100-199" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 100-199/${bytes.byteLength}`);
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), bytes.slice(100, 200));
});

test("re-uploading a version replaces it", async (t) => {
  const f = await fixture(t);
  await f.upload("1.0.5", apk(5000, 1));
  const second = apk(7000, 2);
  const body = await (await f.upload("1.0.5", second)).json();
  assert.equal(body.latest.size, 7000);
  assert.equal(body.latest.sha256, sha256(second));
  assert.deepEqual(await f.keys(), ["app-releases/linekeep-1.0.5.apk"]);
  const stored = await f.bucket.get("app-releases/linekeep-1.0.5.apk");
  assert.equal(sha256(new Uint8Array(await stored.arrayBuffer())), sha256(second));
});

test("only the newest three uploads are kept", async (t) => {
  const f = await fixture(t);
  for (const version of ["1.0.1", "1.0.2", "1.0.3", "1.0.4", "1.0.5"]) {
    assert.equal((await f.upload(version, apk(4096, Number(version.at(-1))))).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.deepEqual(await f.keys(), ["app-releases/linekeep-1.0.3.apk", "app-releases/linekeep-1.0.4.apk", "app-releases/linekeep-1.0.5.apk"]);
  assert.equal((await f.state()).latest.versionName, "1.0.5");
  // Re-uploading an old version makes it the newest and drops the oldest of the rest.
  await f.upload("1.0.3", apk(4096, 33));
  assert.deepEqual(await f.keys(), ["app-releases/linekeep-1.0.3.apk", "app-releases/linekeep-1.0.4.apk", "app-releases/linekeep-1.0.5.apk"]);
  assert.equal((await f.state()).latest.versionName, "1.0.3");
});

test("sharing cannot be turned on without an APK, and the setting is validated", async (t) => {
  const f = await fixture(t);
  const refused = await f.share(true);
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, "INVALID_REQUEST");
  assert.equal((await f.share(false)).status, 200);
  const bad = await f.admin("PUT", "/v1/admin/app/sharing", { body: JSON.stringify({ publicDownload: "yes" }), headers: { "Content-Type": "application/json" } });
  assert.equal(bad.status, 400);
  assert.equal((await f.state()).publicDownload, false);
});

test("removing the APK deletes it, turns sharing off and closes the public routes", async (t) => {
  const f = await fixture(t);
  await f.upload("1.0.4", apk(4096, 4));
  await f.upload("1.0.5", apk(4096, 5));
  await f.share(true);
  assert.equal((await f.call("/download")).status, 200);
  const removed = await f.admin("DELETE", "/v1/admin/app/apk");
  assert.equal(removed.status, 200);
  const body = await removed.json();
  assert.equal(body.latest, null);
  assert.equal(body.publicDownload, false);
  assert.deepEqual(await f.keys(), []);
  assert.equal((await f.call("/download")).status, 404);
  assert.equal((await f.call("/download/linekeep.apk")).status, 404);
  assert.equal((await f.admin("GET", "/v1/admin/app/apk")).status, 404);
  assert.equal((await f.admin("GET", "/v1/admin/app/qr.svg")).status, 404);
  // Sharing stays off after a new upload.
  await f.upload("1.0.6", apk(4096, 6));
  assert.equal((await f.state()).publicDownload, false);
  assert.equal((await f.call("/download")).status, 404);
});

test("administrators can download the latest APK even while sharing is off", async (t) => {
  const f = await fixture(t);
  const bytes = apk(8000);
  await f.upload("1.0.5", bytes);
  const file = await f.admin("GET", "/v1/admin/app/apk");
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), apkType);
  assert.equal(file.headers.get("content-disposition"), 'attachment; filename="linekeep-1.0.5.apk"');
  assert.equal(sha256(new Uint8Array(await file.arrayBuffer())), sha256(bytes));
});

test("the QR code is an SVG for the download page", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.admin("GET", "/v1/admin/app/qr.svg")).status, 404);
  await f.upload("1.0.5", apk(4096));
  const response = await f.admin("GET", "/v1/admin/app/qr.svg");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^image\/svg\+xml/);
  const svg = await response.text();
  assert.match(svg, /^<svg /);
  assert.match(svg, /<path d="M/);
});

test("every admin app route needs an administrator", async (t) => {
  const f = await fixture(t);
  await f.upload("1.0.5", apk(4096));
  await f.share(true);
  const routes = [
    ["GET", "/v1/admin/app"],
    ["PUT", "/v1/admin/app/apk?versionName=9.9"],
    ["GET", "/v1/admin/app/apk"],
    ["DELETE", "/v1/admin/app/apk"],
    ["PUT", "/v1/admin/app/sharing"],
    ["GET", "/v1/admin/app/qr.svg"],
  ];
  for (const [method, path] of routes) {
    const response = await f.call(path, { method, headers: { "Content-Type": apkType }, body: method === "PUT" ? apk(4096) : undefined });
    assert.equal(response.status, 401, `${method} ${path}`);
    const wrong = await f.call(path, { method, headers: { Authorization: "Bearer wrong-secret-wrong-secret-wrong-secret" } });
    assert.equal(wrong.status, 401, `${method} ${path} wrong secret`);
  }
  assert.deepEqual(await f.keys(), ["app-releases/linekeep-1.0.5.apk"]);
  assert.equal((await f.state()).latest.versionName, "1.0.5");
});
