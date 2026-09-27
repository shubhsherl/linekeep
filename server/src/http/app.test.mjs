import assert from "node:assert/strict";
import { generateKeyPairSync, sign as rsaSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { generateSignedCookie } from "hono/cookie";

import { createDatabase, loadModule } from "../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const adminSecret = "synthetic-local-admin-secret-not-for-deployment";
const tokenSecret = "synthetic-token-hash-secret-not-for-deployment";
const issuer = "https://calltracker-test.cloudflareaccess.com";
const audience = "synthetic-access-application";
const accessKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = {
  ...accessKey.publicKey.export({ format: "jwk" }),
  kid: "fixture-key",
  alg: "RS256",
  use: "sig",
};

function accessToken(
  claims = {},
  key = accessKey.privateKey,
  algorithm = "RS256",
) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: algorithm, kid: "fixture-key", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      aud: [audience],
      sub: "synthetic-admin",
      email: "admin@example.invalid",
      iat: now,
      exp: now + 300,
      ...claims,
    }),
  ).toString("base64url");
  const content = `${header}.${payload}`;
  return `${content}.${rsaSign("RSA-SHA256", Buffer.from(content), key).toString("base64url")}`;
}

async function fixture(t, environment = "development") {
  const DB = await createDatabase(t);
  const env = {
    DB,
    ENVIRONMENT: environment,
    LOCAL_ADMIN_SECRET: adminSecret,
    TOKEN_HASH_SECRET: tokenSecret,
    MAX_RECORDING_BYTES: "104857600",
    ACCESS_TEAM_DOMAIN: issuer,
    ACCESS_AUDIENCE: audience,
  };
  const logs = [];
  t.mock.method(console, "log", (message) => logs.push(String(message)));
  const app = createApp();
  const base =
    environment === "development"
      ? "http://127.0.0.1"
      : "https://calltracker.example";
  const request = (path, options = {}, environmentOverrides = {}) =>
    app.request(new URL(path, base), options, {
      ...env,
      ...environmentOverrides,
    });
  return { DB, env, logs, request, base };
}

async function errorResponse(response, status, code) {
  assert.equal(response.status, status);
  const value = await response.json();
  assert.equal(value.error.code, code);
  assert.equal(typeof value.error.message, "string");
  assert.equal(value.requestId, response.headers.get("X-Request-Id"));
  return value;
}

test("local administrator sessions are secret-backed, expiring, HttpOnly and origin-bound", async (t) => {
  const { request, base } = await fixture(t);
  const redirect = await request("/admin");
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.get("Location"), "/admin/login");
  const form = await request("/admin/login");
  assert.equal(form.status, 200);
  assert.equal((await form.text()).includes(adminSecret), false);
  const login = (origin, secret) =>
    request("/admin/session", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ secret }),
    });
  await errorResponse(
    await login("https://attacker.example", adminSecret),
    401,
    "UNAUTHORIZED",
  );
  await errorResponse(await login(base, "incorrect"), 401, "UNAUTHORIZED");
  const session = await login(base, adminSecret);
  assert.equal(session.status, 303);
  const cookieHeader = session.headers.get("Set-Cookie");
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Strict/i);
  assert.equal(cookieHeader.includes(adminSecret), false);
  const cookie = cookieHeader.split(";")[0];
  assert.equal(
    (await request("/admin", { headers: { Cookie: cookie } })).status,
    200,
  );
  const mutation = {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Session fixture" }),
  };
  await errorResponse(
    await request("/v1/admin/employees", mutation),
    401,
    "UNAUTHORIZED",
  );
  assert.equal(
    (
      await request("/v1/admin/employees", {
        ...mutation,
        headers: { ...mutation.headers, Origin: base },
      })
    ).status,
    201,
  );
  const expired = (
    await generateSignedCookie(
      "calltracker_local_admin",
      String(Date.now() - 1),
      `calltracker:local-admin-session:${adminSecret}`,
    )
  ).split(";")[0];
  await errorResponse(
    await request("/v1/admin/calls", { headers: { Cookie: expired } }),
    401,
    "UNAUTHORIZED",
  );
  await errorResponse(
    await request("/v1/admin/calls", {
      headers: { Cookie: `${cookie}tampered` },
    }),
    401,
    "UNAUTHORIZED",
  );
});

test("production requires an authentic unexpired Access identity for the configured issuer and audience", async (t) => {
  const { request } = await fixture(t, "production");
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, `${issuer}/cdn-cgi/access/certs`);
    return Response.json({ keys: [publicJwk] });
  });
  const valid = accessToken();
  const verified = await request("/v1/admin/calls", {
    headers: { "Cf-Access-Jwt-Assertion": valid },
  });
  assert.equal(verified.status, 200);
  assert.deepEqual((await verified.json()).items, []);
  assert.equal(
    (await request("/admin", { headers: { "Cf-Access-Jwt-Assertion": valid } }))
      .status,
    200,
  );
  const rejectedTokens = [
    accessToken({}, otherKey.privateKey),
    accessToken({ exp: Math.floor(Date.now() / 1000) - 1 }),
    accessToken({ exp: undefined }),
    accessToken({ aud: ["different-application"] }),
    accessToken({ iss: "https://attacker.example" }),
    accessToken({ email: undefined }),
    accessToken({}, accessKey.privateKey, "HS256"),
  ];
  for (const token of rejectedTokens) {
    await errorResponse(
      await request("/v1/admin/calls", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
      401,
      "UNAUTHORIZED",
    );
  }
  await errorResponse(
    await request("/v1/admin/calls", {
      headers: { Authorization: `Bearer ${adminSecret}` },
    }),
    401,
    "UNAUTHORIZED",
  );
  await errorResponse(await request("/admin/login"), 404, "NOT_FOUND");
  await errorResponse(
    await request("/admin/session", { method: "POST" }),
    404,
    "NOT_FOUND",
  );
  await errorResponse(
    await request(
      "/v1/admin/calls",
      { headers: { Authorization: `Bearer ${adminSecret}` } },
      { ENVIRONMENT: "development" },
    ),
    401,
    "UNAUTHORIZED",
  );
  await errorResponse(
    await request("/v1/admin/employees", {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": valid,
        Origin: "https://attacker.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Rejected origin" }),
    }),
    401,
    "UNAUTHORIZED",
  );
});

test("Access administrator login works in Workers and rejects redirected signing keys", async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
        import { createApp } from "../app";
        const app = createApp();
        export default {
          fetch(request, env, context) {
            return app.fetch(request, {
              ENVIRONMENT: "production",
              ACCESS_TEAM_DOMAIN: ${JSON.stringify(issuer)},
              ACCESS_AUDIENCE: ${JSON.stringify(audience)},
            }, context);
          }
        };
      `,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  let redirectKeys = false;
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "access-login-regression",
          compatibilityDate: "2026-09-24",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": { type: "esm", contents: bundle.outputFiles[0].text },
            },
          },
        },
        dev: {
          outboundService: {
            type: "fetcher",
            handler(request) {
              if (
                redirectKeys &&
                request.url === `${issuer}/cdn-cgi/access/certs`
              ) {
                return Response.redirect("https://untrusted.example/keys", 302);
              }
              return Response.json({ keys: [publicJwk] });
            },
          },
        },
      },
    ],
  });
  t.after(() => runtime.dispose());
  const request = (token) =>
    runtime.dispatchFetch("https://calltracker.example/admin", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
  const accepted = await request(accessToken());
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers.get("Content-Type"), /text\/html/);
  await accepted.body.cancel();
  await errorResponse(
    await request(accessToken({}, otherKey.privateKey)),
    401,
    "UNAUTHORIZED",
  );
  redirectKeys = true;
  await errorResponse(await request(accessToken()), 401, "UNAUTHORIZED");
});

test("standard API errors and allowlisted logs never echo credentials, query data or storage errors", async (t) => {
  const { DB, request, logs } = await fixture(t);
  const fixtureError = JSON.parse(
    await readFile(
      new URL("../../fixtures/error-response.json", import.meta.url),
      "utf8",
    ),
  );
  const registration = JSON.parse(
    await readFile(
      new URL("../../fixtures/registration-request.json", import.meta.url),
      "utf8",
    ),
  );
  await errorResponse(
    await request("/v1/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration),
    }),
    401,
    fixtureError.error.code,
  );
  await errorResponse(
    await request("/v1/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    }),
    400,
    "INVALID_REQUEST",
  );
  await errorResponse(
    await request("/v1/device/register", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not JSON",
    }),
    400,
    "INVALID_REQUEST",
  );
  await errorResponse(
    await request("/v1/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationCode: "x".repeat(17000) }),
    }),
    413,
    "FILE_TOO_LARGE",
  );
  await errorResponse(
    await request(
      "/not-a-route?signature=synthetic-signed-url-secret&number=15555550999",
    ),
    404,
    "NOT_FOUND",
  );
  await DB.prepare(
    "CREATE TRIGGER fail_employee_insert BEFORE INSERT ON employees BEGIN SELECT RAISE(ABORT, 'synthetic-private-storage-error'); END",
  ).run();
  const failed = await errorResponse(
    await request("/v1/admin/employees", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "synthetic-private-name",
        phoneNumber: "+15555550999",
      }),
    }),
    500,
    "INTERNAL_ERROR",
  );
  const output = JSON.stringify([logs, failed]);
  for (const secret of [
    adminSecret,
    tokenSecret,
    registration.invitationCode,
    "synthetic-signed-url-secret",
    "15555550999",
    "synthetic-private-storage-error",
    "synthetic-private-name",
  ])
    assert.equal(output.includes(secret), false);
});
