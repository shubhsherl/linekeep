export const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";

export class CloudflareError extends Error {
  constructor(message, { status, errors } = {}) {
    super(message);
    this.name = "CloudflareError";
    this.status = status;
    this.errors = errors ?? [];
  }
}

/**
 * Minimal Cloudflare REST client. The token is held in a closure and only ever sent as an Authorization header;
 * it is never part of an error message, URL or log line.
 */
export function createCloudflare({ token, baseUrl = DEFAULT_BASE_URL, fetch: fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
  /** Returns { status, ok, result, errors, resultInfo }. Never throws on HTTP errors, only on network failure. */
  async function raw(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new CloudflareError(`Network error calling Cloudflare (${method} ${path}): ${error?.cause?.code ?? error?.name ?? "unknown"}`);
    }
    let json = null;
    try {
      json = await response.json();
    } catch {
      /* non-JSON body */
    }
    return {
      status: response.status,
      ok: response.ok && json?.success !== false,
      result: json?.result ?? null,
      errors: Array.isArray(json?.errors) ? json.errors : [],
      resultInfo: json?.result_info ?? null,
    };
  }

  const describe = (r) => {
    const detail = r.errors.map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).filter(Boolean).join("; ");
    return `HTTP ${r.status}${detail ? `: ${detail}` : ""}`;
  };

  async function call(method, path, body) {
    const r = await raw(method, path, body);
    if (!r.ok) throw new CloudflareError(`Cloudflare ${method} ${path} failed (${describe(r)})`, { status: r.status, errors: r.errors });
    return r.result;
  }

  const enc = encodeURIComponent;
  const acct = (id) => `/accounts/${enc(id)}`;

  return {
    raw,
    call,
    describe,

    /** Returns { active: boolean, kind } using the user endpoint, then the account endpoint for account-owned tokens. */
    async verifyToken(accountIds = []) {
      const user = await raw("GET", "/user/tokens/verify");
      if (user.ok && user.result?.status === "active") return { active: true, kind: "user" };
      for (const id of accountIds) {
        const r = await raw("GET", `${acct(id)}/tokens/verify`);
        if (r.ok && r.result?.status === "active") return { active: true, kind: "account", accountId: id };
      }
      return { active: false, status: user.status };
    },
    async listAccounts() {
      const r = await raw("GET", "/accounts?per_page=50");
      if (!r.ok) throw new CloudflareError(`Could not list accounts (${describe(r)}). Check the token is valid and has Account Settings: Read.`, { status: r.status });
      return (r.result ?? []).map((a) => ({ id: a.id, name: a.name }));
    },

    async getSubdomain(accountId) {
      const r = await raw("GET", `${acct(accountId)}/workers/subdomain`);
      if (r.ok) return r.result?.subdomain ?? null;
      if (r.status === 404 || r.status === 400) return null;
      throw new CloudflareError(`Could not read workers.dev subdomain (${describe(r)})`, { status: r.status });
    },
    putSubdomain: (accountId, subdomain) => call("PUT", `${acct(accountId)}/workers/subdomain`, { subdomain }),

    async findD1(accountId, name) {
      const list = await call("GET", `${acct(accountId)}/d1/database?name=${enc(name)}&per_page=100`);
      const hit = (list ?? []).find((d) => d.name === name);
      return hit ? { id: hit.uuid, name: hit.name } : null;
    },
    async createD1(accountId, name) {
      const d = await call("POST", `${acct(accountId)}/d1/database`, { name });
      return { id: d.uuid, name: d.name };
    },

    async findBucket(accountId, name) {
      const result = await call("GET", `${acct(accountId)}/r2/buckets?name_contains=${enc(name)}&per_page=1000`);
      const hit = (result?.buckets ?? []).find((b) => b.name === name);
      return hit ? { name: hit.name } : null;
    },
    async createBucket(accountId, name) {
      const b = await call("POST", `${acct(accountId)}/r2/buckets`, { name });
      return { name: b.name ?? name };
    },
    /** { managedEnabled, customDomains } or null when it cannot be determined. */
    async bucketExposure(accountId, name) {
      const base = `${acct(accountId)}/r2/buckets/${enc(name)}/domains`;
      const managed = await raw("GET", `${base}/managed`);
      const custom = await raw("GET", `${base}/custom`);
      if (!managed.ok || !custom.ok) return null;
      return {
        managedEnabled: managed.result?.enabled === true,
        customDomains: (custom.result?.domains ?? []).map((d) => d.domain),
      };
    },
    disableManagedDomain: (accountId, name) => call("PUT", `${acct(accountId)}/r2/buckets/${enc(name)}/domains/managed`, { enabled: false }),

    /** Access organization (Zero Trust). Null when Zero Trust is not enabled yet. */
    async getOrganization(accountId) {
      const r = await raw("GET", `${acct(accountId)}/access/organizations`);
      if (r.ok && r.result?.auth_domain) return r.result;
      if (r.status === 401 || r.status === 403) {
        if (r.errors.some((e) => /not.?enabled|not.?found/i.test(`${e.message} ${e.code}`))) return null;
        throw new CloudflareError(`Could not read the Access organization (${describe(r)})`, { status: r.status });
      }
      return null;
    },
    createOrganization: (accountId, authDomain, name) =>
      call("POST", `${acct(accountId)}/access/organizations`, { name, auth_domain: authDomain }),

    listIdentityProviders: async (accountId) => (await call("GET", `${acct(accountId)}/access/identity_providers`)) ?? [],
    createOneTimePin: (accountId) =>
      call("POST", `${acct(accountId)}/access/identity_providers`, { name: "One-time PIN", type: "onetimepin", config: {} }),

    async listAccessApps(accountId) {
      const apps = [];
      for (let page = 1; page <= 20; page++) {
        const r = await raw("GET", `${acct(accountId)}/access/apps?per_page=100&page=${page}`);
        if (!r.ok) throw new CloudflareError(`Could not list Access applications (${describe(r)})`, { status: r.status });
        apps.push(...(r.result ?? []));
        if (!r.resultInfo || page >= (r.resultInfo.total_pages ?? 1)) break;
      }
      return apps;
    },
    getAccessApp: (accountId, appId) => call("GET", `${acct(accountId)}/access/apps/${enc(appId)}`),
    createAccessApp: (accountId, body) => call("POST", `${acct(accountId)}/access/apps`, body),
    updateAccessApp: (accountId, appId, body) => call("PUT", `${acct(accountId)}/access/apps/${enc(appId)}`, body),

    getAccessPolicy: (accountId, policyId) => call("GET", `${acct(accountId)}/access/policies/${enc(policyId)}`),
    createAccessPolicy: (accountId, body) => call("POST", `${acct(accountId)}/access/policies`, body),
    updateAccessPolicy: (accountId, policyId, body) => call("PUT", `${acct(accountId)}/access/policies/${enc(policyId)}`, body),
  };
}
