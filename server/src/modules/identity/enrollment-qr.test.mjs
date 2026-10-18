import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "../../data/test-support.mjs";
const { enrollmentUri, qrSvg } = await loadModule("../modules/identity/enrollment-qr.ts");
test("uri round trips symbols", () => {
  const code = "a b&c=d/é+%";
  const uri = new URL(enrollmentUri("https://x.example", code));
  assert.equal(uri.protocol, "linekeep:"); assert.equal(uri.host, "enroll");
  assert.equal(uri.searchParams.get("server"), "https://x.example"); assert.equal(uri.searchParams.get("code"), code);
});
test("svg has no scripts or style attributes", () => {
  const svg = qrSvg(enrollmentUri("https://linekeep.example", "x".repeat(60)));
  assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/); assert.ok(!/style=|<script|href=/.test(svg));
});
