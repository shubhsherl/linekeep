// Pure validators. Each returns { ok: true, value } or { ok: false, error }.
const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error });
const text = (raw) => (typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw).trim());

export function parseEnvName(raw) {
  const v = text(raw);
  return /^[a-z][a-z0-9-]{0,30}[a-z0-9]$|^[a-z]$/.test(v)
    ? ok(v)
    : fail("Use lowercase letters, digits and hyphens, starting with a letter (e.g. production, dev).");
}

export function parseWorkerName(raw) {
  const v = text(raw);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v)
    ? ok(v)
    : fail("Worker names are 1-63 lowercase letters, digits or hyphens, not starting or ending with a hyphen.");
}

export function parseD1Name(raw) {
  const v = text(raw);
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(v)
    ? ok(v)
    : fail("D1 names are 1-63 letters, digits, hyphens or underscores, starting with a letter or digit.");
}

export function parseBucketName(raw) {
  const v = text(raw);
  return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(v)
    ? ok(v)
    : fail("R2 bucket names are 3-63 lowercase letters, digits or hyphens, starting and ending with a letter or digit.");
}

export function parseEmail(raw) {
  const v = text(raw);
  return v.length <= 254 && /^[^\s@,;<>()[\]"']+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(v)
    ? ok(v.toLowerCase())
    : fail(`"${v}" is not a valid email address.`);
}

export function parseEmailList(raw, { max = 1000 } = {}) {
  const parts = (Array.isArray(raw) ? raw : String(raw ?? "").split(","))
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (parts.length === 0) return fail("Enter at least one email address (comma separated).");
  const emails = [];
  for (const part of parts) {
    const r = parseEmail(part);
    if (!r.ok) return r;
    if (!emails.includes(r.value)) emails.push(r.value);
  }
  if (emails.length > max) return fail(`At most ${max} addresses are supported.`);
  return ok(emails);
}

export function parseDomain(raw) {
  const v = text(raw).toLowerCase();
  return v.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v)
    ? ok(v)
    : fail("Enter a bare domain such as mg.example.com (no scheme or path).");
}

export function parseRegion(raw) {
  const v = text(raw).toLowerCase();
  return v === "us" || v === "eu" ? ok(v) : fail("Region must be us or eu.");
}

export function parseInteger(raw, { min, max, label }) {
  const v = text(raw);
  if (!/^\d{1,6}$/.test(v)) return fail(`${label} must be a whole number.`);
  const n = Number(v);
  return n >= min && n <= max ? ok(n) : fail(`${label} must be between ${min} and ${max}.`);
}
export const parseDays = (raw) => parseInteger(raw, { min: 1, max: 9999, label: "Retention days" });
export const parseMegabytes = (raw) => parseInteger(raw, { min: 1, max: 500, label: "Maximum recording size (MB)" });

export function parseSessionDuration(raw) {
  const v = text(raw).toLowerCase();
  return /^[1-9]\d{0,3}[mh]$/.test(v) ? ok(v) : fail("Use a duration such as 30m, 1h, 8h or 24h.");
}

export function parseTeamName(raw) {
  const v = text(raw).toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(v)
    ? ok(v)
    : fail("Team names are 3-63 lowercase letters, digits or hyphens (your login host becomes <name>.cloudflareaccess.com).");
}

export function parseSubdomain(raw) {
  const v = text(raw).toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v)
    ? ok(v)
    : fail("workers.dev subdomains are 1-63 lowercase letters, digits or hyphens.");
}

/** "18:00" or "5:15" (IST, 24h) -> "HH:MM". The Worker sends at the half-hour slot it falls in (18:10 sends at 18:00). */
export function parseIstTime(raw) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text(raw));
  if (!m) return fail("Enter a 24-hour IST time such as 18:00.");
  return ok(`${m[1].padStart(2, "0")}:${m[2]}`);
}

export function parseApiToken(raw) {
  const v = text(raw);
  return /^[A-Za-z0-9_-]{20,}$/.test(v) ? ok(v) : fail("That does not look like a Cloudflare API token.");
}

/** Meta numeric identifiers (app, WhatsApp Business Account, phone number): 5-32 digits. */
export function parseMetaId(raw, label = "ID") {
  const v = text(raw);
  return /^\d{5,32}$/.test(v) ? ok(v) : fail(`${label} must be 5-32 digits (copy it from the Meta dashboard).`);
}

/** Opaque credential (system user token, app secret): non-empty, no whitespace. Never echoes the value. */
export function parseCredential(raw, label = "value") {
  const v = text(raw);
  if (v === "") return fail(`The ${label} cannot be empty.`);
  if (/\s/.test(v)) return fail(`The ${label} must not contain spaces or line breaks (check for a bad paste).`);
  if (v.length > 4096) return fail(`The ${label} is unreasonably long.`);
  return ok(v);
}
