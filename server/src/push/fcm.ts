import type { Env } from "../env";

interface ServiceAccount { client_email: string; private_key: string; project_id: string }

export type PushData = { type: "message" | "assigned"; customerId: string; customerName: string; title: string; body: string };
export type PushResult = "sent" | "invalid-token" | "failed";

/** The sending key, or null when push is not configured (the feature is then silently off). */
export function pushAccount(env: Pick<Env, "FCM_SERVICE_ACCOUNT">): ServiceAccount | null {
  const raw = env.FCM_SERVICE_ACCOUNT?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
    return parsed.client_email && parsed.private_key && /^[a-z][a-z0-9-]{4,}$/.test(parsed.project_id ?? "")
      ? (parsed as ServiceAccount) : null;
  } catch {
    return null;
  }
}

const base64url = (bytes: ArrayBuffer | string): string => {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const tokens = new Map<string, { value: string; expires: number }>();

/** A short-lived OAuth token for the service account, cached per isolate until a minute before it expires. */
async function accessToken(account: ServiceAccount): Promise<string> {
  const cached = tokens.get(account.client_email);
  if (cached && cached.expires > Date.now() + 60_000) return cached.value;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({
    iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000,
  }))}`;
  const pem = account.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8", Uint8Array.from(atob(pem), (character) => character.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${base64url(signature)}` }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null) as { access_token?: string; expires_in?: number } | null;
  if (!response.ok || !body?.access_token) throw new Error("push token request failed");
  tokens.set(account.client_email, { value: body.access_token, expires: Date.now() + (body.expires_in ?? 3000) * 1000 });
  return body.access_token;
}

/** One data-only, high-priority message. The app writes the notification itself, so no text is shown by FCM. */
export async function sendPush(account: ServiceAccount, token: string, data: PushData): Promise<PushResult> {
  try {
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await accessToken(account)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { token, data, android: { priority: "HIGH", ttl: "3600s", collapse_key: data.customerId.slice(0, 64) } } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return "sent";
    const body = await response.json().catch(() => null) as { error?: { status?: string; message?: string; details?: { errorCode?: string }[] } } | null;
    const code = body?.error?.details?.find((detail) => detail.errorCode)?.errorCode;
    return code === "UNREGISTERED" || response.status === 404
      || (body?.error?.status === "INVALID_ARGUMENT" && /registration token/i.test(body.error.message ?? ""))
      ? "invalid-token" : "failed";
  } catch {
    return "failed";
  }
}
