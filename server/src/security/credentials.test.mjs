import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { loadModule } from "../data/test-support.mjs";

const { createCredentials } = await loadModule("../security/credentials.ts");
const secret = "synthetic-test-key-not-for-deployment";

test("credentials use independent random secrets and purpose/key-bound HMACs", async () => {
  const credentials = createCredentials(secret);
  const first = await credentials.issueDeviceToken();
  const second = await credentials.issueDeviceToken();
  const invitation = await credentials.issueInvitationCode();
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.hash, second.hash);
  assert.equal(
    first.hash,
    createHmac("sha256", secret)
      .update(`calltracker:device:${first.token}`)
      .digest("hex"),
  );
  assert.equal(
    invitation.hash,
    createHmac("sha256", secret)
      .update(`calltracker:invitation:${invitation.code}`)
      .digest("hex"),
  );
  assert.equal(await credentials.hashDeviceToken(first.token), first.hash);
  assert.notEqual(
    await credentials.hashInvitationCode(first.token),
    first.hash,
  );
  assert.notEqual(
    await createCredentials(
      "another-synthetic-test-key-not-for-deployment",
    ).hashDeviceToken(first.token),
    first.hash,
  );
});

test("missing or undersized hashing keys fail closed", () => {
  assert.throws(() => createCredentials(undefined));
  assert.throws(() => createCredentials(""));
  assert.throws(() => createCredentials("x".repeat(31)));
});
