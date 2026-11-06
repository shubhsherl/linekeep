// WhatsApp (Meta Cloud API) helpers: prerequisites text, webhook URL and the Meta Graph calls. The call builder is
// PURE; execution takes an injectable fetch. Secret values are only ever placed into request bodies/headers, never text.
export const GRAPH_VERSION = "v23.0"; // matches the Worker's default WHATSAPP_GRAPH_VERSION
export const WEBHOOK_PATH = "/v1/webhooks/whatsapp";
export const WEBHOOK_FIELDS = "messages";

export const WHATSAPP_PREREQUISITES = [
  "WhatsApp Business needs these things from Meta. Have them ready before you continue:",
  "  1. A Meta developer account and a Business app with the WhatsApp product (developers.facebook.com),",
  "     connected to your Meta Business.",
  "  2. A WhatsApp Business Account (WABA) with a registered phone number. The number must not be active in the",
  "     consumer WhatsApp app; a test number from the app dashboard works for trying it.",
  "  3. A system user token that never expires: Business Settings -> Users -> System users, assign the app and the",
  "     WhatsApp account with full control, then generate a token with whatsapp_business_management and",
  "     whatsapp_business_messaging.",
  "  4. From the app: App ID and App secret (App settings -> Basic), and the WABA ID and Phone number ID",
  "     (WhatsApp -> API Setup).",
  "  5. Before real customers can reach you: a Privacy policy URL, app icon and category on App settings -> Basic,",
  "     then switch the app to Live mode. Until it is Live, customers' messages reach the webhook only for people",
  "     with a role on the app.",
  "  6. Message templates approved in WhatsApp Manager (needed to start conversations), and a payment method on",
  "     the WABA for paid template messages.",
];

export const WHATSAPP_SECRET_NAMES = ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_WABA_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"];

export function webhookUrl(workerUrl) {
  return `${String(workerUrl).replace(/\/+$/, "")}${WEBHOOK_PATH}`;
}

/** Placeholders shown instead of secret values in plans and dry runs. */
export const PLACEHOLDERS = {
  verifyToken: "<WHATSAPP_VERIFY_TOKEN>",
  appSecret: "<WHATSAPP_APP_SECRET>",
  accessToken: "<WHATSAPP_TOKEN>",
};

/**
 * The two Graph calls that register the webhook. `fields` are form fields (sent urlencoded in the POST body, never in
 * the URL); `headers` carry the system user token. Pass PLACEHOLDERS for secrets to get a printable description.
 */
export function buildMetaCalls({ appId, wabaId, callbackUrl, verifyToken, appSecret, accessToken }) {
  const form = (fields) => new URLSearchParams(fields).toString();
  const subscription = {
    object: "whatsapp_business_account",
    callback_url: callbackUrl,
    verify_token: verifyToken,
    fields: WEBHOOK_FIELDS,
    access_token: `${appId}|${appSecret}`,
  };
  return [
    {
      title: "Register the webhook callback for the app",
      method: "POST",
      url: `https://graph.facebook.com/${GRAPH_VERSION}/${appId}/subscriptions`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      fields: subscription,
      body: form(subscription),
    },
    {
      title: "Subscribe the app to the WhatsApp Business Account",
      method: "POST",
      url: `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/subscribed_apps`,
      headers: { Authorization: `Bearer ${accessToken}` },
      fields: {},
      body: "",
    },
  ];
}

/** Printable lines for the calls with secrets replaced by placeholders (used by the plan and by --dry-run). */
export function describeMetaCalls({ appId, wabaId, callbackUrl }) {
  const calls = buildMetaCalls({ appId, wabaId, callbackUrl, ...PLACEHOLDERS });
  return calls.flatMap((c) => [
    `${c.method} ${c.url}`,
    ...Object.entries(c.fields).map(([k, v]) => `    ${k}=${v}`),
    ...(c.headers.Authorization ? [`    Authorization: Bearer ${PLACEHOLDERS.accessToken}`] : []),
  ]);
}

export class MetaError extends Error {}

/** Executes the calls in order. Throws MetaError with Meta's message (never request contents). */
export async function registerWebhook(fetchFn, calls) {
  for (const call of calls) {
    let res;
    try {
      res = await fetchFn(call.url, { method: call.method, headers: call.headers, body: call.body || undefined, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      throw new MetaError(`"${call.title}" could not reach graph.facebook.com (${error?.name ?? "network error"}).`);
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON answer */
    }
    if (!res.ok || body?.error || body?.success !== true) {
      const e = body?.error;
      const detail = e ? `${e.message ?? "unknown error"}${e.code !== undefined ? ` (code ${e.code})` : ""}` : "unexpected answer";
      throw new MetaError(`"${call.title}" was rejected by Meta (HTTP ${res.status}): ${detail}`);
    }
  }
}

/** Manual webhook instructions. The verify token is a secret: it is never printed. */
export function manualWebhookInstructions({ callbackUrl, wabaId, env }) {
  return [
    "To register the webhook yourself (Meta app dashboard -> WhatsApp -> Configuration -> Webhook -> Edit):",
    `  Callback URL:  ${callbackUrl}`,
    `  Fields:        subscribe to "${WEBHOOK_FIELDS}"`,
    "  Verify token:  the stored token is a secret and is never shown. Choose a new random value, store it in the",
    "                 Worker, and enter the same value in Meta:",
    `                   npx wrangler secret put WHATSAPP_VERIFY_TOKEN --env ${env}`,
    `  Then link the app to the account with a POST to https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/subscribed_apps`,
    "  using your system user token as a Bearer token (Meta's dashboard does this when you subscribe the account).",
  ];
}

/** What remains on Meta's side. `registered` tells whether the webhook step succeeded this run. */
export function whatsappChecklist({ registered, callbackUrl }) {
  const lines = ["WhatsApp: what still has to happen in Meta (setup cannot do or verify these):"];
  if (registered) lines.push("  [x] Webhook registered for messages (setup did this).");
  else lines.push(`  [ ] Register the webhook at ${callbackUrl} (see the instructions above).`);
  lines.push(
    "  [ ] App in Live mode (App settings -> Basic needs a Privacy policy URL, app icon and category). Until then,",
    "      customers' messages reach you only from people with a role on the app.",
    "  [ ] At least one message template approved in WhatsApp Manager; templates are required to start a conversation",
    "      and to message customers more than 24 hours after their last message.",
    "  [ ] A payment method on the WhatsApp Business Account (WhatsApp Manager -> Billing) for paid template messages.",
  );
  return lines;
}
