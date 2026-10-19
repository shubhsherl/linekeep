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

const CRON_FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] },
  { name: "day of week", min: 0, max: 7, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] },
];

export function parseCron(raw) {
  const v = text(raw).replace(/\s+/g, " ");
  const fields = v.split(" ");
  if (fields.length !== 5) return fail("A cron expression has exactly 5 fields: minute hour day-of-month month day-of-week.");
  for (const [i, field] of fields.entries()) {
    const spec = CRON_FIELDS[i];
    const num = (token) => {
      if (/^\d+$/.test(token)) {
        const n = Number(token);
        return n >= spec.min && n <= spec.max;
      }
      return spec.names?.includes(token.toUpperCase()) ?? false;
    };
    for (const item of field.split(",")) {
      const [range, step, extra] = item.split("/");
      if (extra !== undefined || (step !== undefined && !/^[1-9]\d*$/.test(step))) return fail(`Invalid ${spec.name} field "${field}".`);
      if (range === "*" || (spec.name === "day of month" || spec.name === "day of week") && range === "?") continue;
      const bounds = range.split("-");
      if (bounds.length > 2 || !bounds.every(num)) return fail(`Invalid ${spec.name} field "${field}".`);
    }
  }
  return ok(fields.join(" "));
}

/** "18:00" (IST, 24h) -> minute/hour in UTC cron. IST is UTC+5:30 with no DST. */
export function istTimeToCron(raw) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text(raw));
  if (!m) return fail("Enter a 24-hour IST time such as 18:00.");
  const utc = (Number(m[1]) * 60 + Number(m[2]) - 330 + 1440) % 1440;
  return ok(`${utc % 60} ${Math.floor(utc / 60)} * * *`);
}

/** Inverse for daily crons ("m h * * *") so the UTC cron can be shown in IST. Null for other shapes. */
export function cronToIst(cron) {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron);
  if (!m || Number(m[1]) > 59 || Number(m[2]) > 23) return null;
  const ist = (Number(m[2]) * 60 + Number(m[1]) + 330) % 1440;
  return `${String(Math.floor(ist / 60)).padStart(2, "0")}:${String(ist % 60).padStart(2, "0")}`;
}

export function parseApiToken(raw) {
  const v = text(raw);
  return /^[A-Za-z0-9_-]{20,}$/.test(v) ? ok(v) : fail("That does not look like a Cloudflare API token.");
}
