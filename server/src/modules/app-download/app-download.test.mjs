import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { COMMUNITY_APK_REPO, COMMUNITY_APK_ASSET, communityApkUrl, communityReleasesUrl } = await loadModule("../modules/app-download/community-build.ts");
const adminSecret = "synthetic-app-download-admin-secret-not-for-deployment";

// The download routes use no database or bucket (the server stores no APK); the database only serves the shared /v1 settings lookup.
async function fixture(t) {
  const app = createApp();
  const env = { DB: await createDatabase(t), ENVIRONMENT: "development", LOCAL_ADMIN_SECRET: adminSecret };
  const call = (path, init = {}) => app.request(new URL(path, "http://127.0.0.1"), init, env);
  const admin = (path, init = {}) => call(path, { ...init, headers: { Authorization: `Bearer ${adminSecret}`, ...init.headers } });
  return { call, admin };
}

test("the community build lives in one place", () => {
  assert.equal(communityReleasesUrl, `https://github.com/${COMMUNITY_APK_REPO}/releases/latest`);
  assert.equal(communityApkUrl, `https://github.com/${COMMUNITY_APK_REPO}/releases/latest/download/${COMMUNITY_APK_ASSET}`);
  assert.equal(communityApkUrl, "https://github.com/shubhsherl/linekeep/releases/latest/download/linekeep.apk");
});

test("the download page is public, self-contained and names the community build", async (t) => {
  const { call, admin } = await fixture(t);
  const response = await call("/download");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  const policy = response.headers.get("content-security-policy");
  assert.match(policy, /default-src 'none'/);
  assert.doesNotMatch(policy, /script-src|https?:/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  const html = await response.text();
  assert.match(html, /<title>Linekeep Community Android build<\/title>/);
  assert.ok(html.includes("community-maintained build"));
  assert.ok(html.includes(`href="${communityReleasesUrl}"`));
  assert.ok(html.includes('href="/download/linekeep.apk"'));
  assert.match(html, /Install unknown apps/);
  assert.match(html, /enrollment QR code or setup code separately/);
  assert.match(html, /version and the changelog/);
  assert.doesNotMatch(html, /<script|<link|<img|<iframe|url\(|(?:src|href)=["']?https?:\/\/(?!github\.com\/)/i);
  assert.equal((html.match(/<li>/g) ?? []).length, 4);
  assert.equal((await call("/download", { method: "HEAD" })).status, 200);
});

test("the APK path redirects to the GitHub release without caching", async (t) => {
  const { call, admin } = await fixture(t);
  for (const method of ["GET", "HEAD"]) {
    const response = await call("/download/linekeep.apk", { method, redirect: "manual" });
    assert.equal(response.status, 302, method);
    assert.equal(response.headers.get("location"), "https://github.com/shubhsherl/linekeep/releases/latest/download/linekeep.apk");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("the QR code is an SVG for the download page and needs an administrator", async (t) => {
  const { call, admin } = await fixture(t);
  assert.equal((await call("/v1/admin/app/qr.svg")).status, 401);
  assert.equal((await call("/v1/admin/app/qr.svg", { headers: { Authorization: "Bearer wrong-secret-wrong-secret-wrong-secret" } })).status, 401);
  const response = await admin("/v1/admin/app/qr.svg");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^image\/svg\+xml/);
  const svg = await response.text();
  assert.match(svg, /^<svg /);
  assert.match(svg, /<path d="M/);
});

test("the removed upload and sharing routes are gone", async (t) => {
  const { call, admin } = await fixture(t);
  for (const [method, path] of [
    ["GET", "/v1/admin/app"], ["PUT", "/v1/admin/app/apk?versionName=1.0.5"], ["GET", "/v1/admin/app/apk"],
    ["DELETE", "/v1/admin/app/apk"], ["PUT", "/v1/admin/app/sharing"],
  ]) {
    const response = await admin(path, { method });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  assert.equal((await call("/download/other.apk")).status, 404);
});
