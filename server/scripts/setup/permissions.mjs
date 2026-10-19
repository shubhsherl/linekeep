// Required API token permissions (Account scope) and the harmless read probes that detect missing ones.
export const PERMISSIONS = {
  workersScripts: { label: "Workers Scripts: Edit", feature: "core", probe: (a) => `/accounts/${a}/workers/scripts` },
  d1: { label: "D1: Edit", feature: "core", probe: (a) => `/accounts/${a}/d1/database?per_page=1` },
  r2: { label: "Workers R2 Storage: Edit", feature: "core", probe: (a) => `/accounts/${a}/r2/buckets?per_page=1` },
  accountSettings: { label: "Account Settings: Read", feature: "core", probe: (a) => `/accounts/${a}/workers/subdomain` },
  accessApps: { label: "Access: Apps and Policies: Edit", feature: "access", probe: (a) => `/accounts/${a}/access/apps?per_page=1` },
  accessIdp: {
    label: "Access: Organizations, Identity Providers, and Groups: Edit",
    feature: "access",
    probe: (a) => `/accounts/${a}/access/identity_providers`,
    extraProbes: (a) => [`/accounts/${a}/access/organizations`],
  },
};

export const TOKEN_HELP = [
  "Create or edit the token in the Cloudflare dashboard:",
  "  My Profile > API Tokens (or Manage Account > Account API Tokens) > Create Token > Create Custom Token.",
  "  Add the permissions marked [!!] above (all at Account scope, limited to your account), then re-run setup.",
  "Note: read probes cannot tell Read from Edit; a token with Read only will pass here and fail when creating resources.",
];

export function requiredPermissions(features) {
  return Object.values(PERMISSIONS).filter((p) => p.feature === "core" || features.includes(p.feature));
}

/**
 * Probe each required permission with read-only calls. 401/403 means missing; other statuses (including 404 for
 * "no workers.dev subdomain yet" or "Zero Trust not enabled") prove the permission is granted.
 * Returns [{ label, ok, detail }].
 */
export async function probePermissions(cf, accountId, features) {
  const results = [];
  for (const perm of requiredPermissions(features)) {
    const paths = [perm.probe(accountId), ...(perm.extraProbes?.(accountId) ?? [])];
    let ok = true;
    let detail = "";
    for (const path of paths) {
      const r = await cf.raw("GET", path);
      const denied = r.status === 401 || r.status === 403;
      const notEnabled = r.errors.some((e) => /not.?enabled/i.test(`${e.message}`));
      if (denied && !notEnabled) {
        ok = false;
        detail = `HTTP ${r.status} on ${path.split("?")[0].replace(accountId, "{account}")}`;
        break;
      }
    }
    results.push({ label: perm.label, ok, detail });
  }
  return results;
}

export function renderProbeReport(results, say) {
  for (const r of results) say(`  ${r.ok ? "[ok]" : "[!!]"} ${r.label}${r.ok ? "" : `  (${r.detail})`}`);
  const missing = results.filter((r) => !r.ok);
  if (missing.length) {
    say("");
    say("Missing token permissions (Account scope):");
    for (const m of missing) say(`  - ${m.label}`);
    for (const line of TOKEN_HELP) say(line);
  }
  return missing.length === 0;
}
