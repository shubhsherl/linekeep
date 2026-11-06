import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase, loadModule } from "../data/test-support.mjs";

const { createSettingsCipher } = await loadModule("../settings/crypto.ts");
const { createSettingsStore, SettingsEncryptionUnavailableError } = await loadModule("../settings/store.ts");
const secret = "synthetic-settings-secret-not-for-deployment";
const row = (db, key) => db.prepare("SELECT value, encrypted FROM app_settings WHERE key = ?").bind(key).first();

test("encryption round-trips, uses a fresh IV, and binds the setting key as authenticated data", async () => {
  const cipher = await createSettingsCipher(secret);
  const a = await cipher.encrypt("whatsapp.token", "synthetic-token-value");
  const b = await cipher.encrypt("whatsapp.token", "synthetic-token-value");
  assert.match(a, /^v1\.[\w-]+\.[\w-]+$/);
  assert.notEqual(a, b);
  assert.ok(!a.includes("synthetic-token-value"));
  assert.equal(await cipher.decrypt("whatsapp.token", a), "synthetic-token-value");
  await assert.rejects(cipher.decrypt("whatsapp.appSecret", a), /cannot be decrypted/);
  const [version, iv, body] = a.split(".");
  const flipped = body.slice(0, -2) + (body.endsWith("AA") ? "BB" : "AA");
  await assert.rejects(cipher.decrypt("whatsapp.token", [version, iv, flipped].join(".")));
  await assert.rejects(cipher.decrypt("whatsapp.token", "v2.x.y"), /Unsupported/);
  const other = await createSettingsCipher("another-synthetic-secret-not-for-deployment");
  await assert.rejects(other.decrypt("whatsapp.token", a));
  await assert.rejects(createSettingsCipher("short"), /at least 32 bytes/);
});

test("stored secrets are ciphertext, plain settings are not, and rows moved between keys are unreadable", async (t) => {
  const DB = await createDatabase(t);
  const store = createSettingsStore(DB, secret);
  await store.write([
    { key: "whatsapp.token", value: "synthetic-token-value", secret: true },
    { key: "whatsapp.appSecret", value: "synthetic-app-secret-value", secret: true },
    { key: "whatsapp.phoneNumberId", value: "1000000000000001" },
  ]);
  const token = await row(DB, "whatsapp.token");
  assert.equal(token.encrypted, 1);
  assert.ok(!token.value.includes("synthetic-token-value"));
  assert.deepEqual(await row(DB, "whatsapp.phoneNumberId"), { value: "1000000000000001", encrypted: 0 });
  assert.equal((await store.readAll()).values.get("whatsapp.token"), "synthetic-token-value");

  // Copy one secret's ciphertext over the other: authentication must fail, never yield a value.
  await DB.prepare("UPDATE app_settings SET value = ? WHERE key = 'whatsapp.appSecret'").bind(token.value).run();
  const swapped = await store.readAll();
  assert.equal(swapped.values.has("whatsapp.appSecret"), false);
  assert.ok(swapped.unreadable.has("whatsapp.appSecret"));
  assert.equal(swapped.values.get("whatsapp.token"), "synthetic-token-value");

  // A different TOKEN_HASH_SECRET, or none, cannot read the secrets but still reads plain settings.
  for (const wrong of ["another-synthetic-secret-not-for-deployment", undefined]) {
    const result = await createSettingsStore(DB, wrong).readAll();
    assert.ok(result.unreadable.has("whatsapp.token"));
    assert.equal(result.values.get("whatsapp.phoneNumberId"), "1000000000000001");
  }
});

test("saving a secret without TOKEN_HASH_SECRET fails clearly; plain values and deletes still work", async (t) => {
  const DB = await createDatabase(t);
  const store = createSettingsStore(DB, undefined);
  await assert.rejects(store.write([{ key: "whatsapp.token", value: "synthetic-token-value", secret: true }]), SettingsEncryptionUnavailableError);
  assert.equal(await row(DB, "whatsapp.token"), null);
  await store.write([{ key: "whatsapp.wabaId", value: "1000000000000002" }]);
  await store.write([{ key: "whatsapp.wabaId", value: null }]);
  assert.equal(await row(DB, "whatsapp.wabaId"), null);
});
