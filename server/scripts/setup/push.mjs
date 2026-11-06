// Push notification (Firebase Cloud Messaging) helpers. PURE parsing of the two JSON files an operator downloads from
// Google. Error messages never include file contents (JSON.parse messages can quote them), only names and paths.
export const ANDROID_PACKAGE = "com.microorganics.calltracker";
export const PUSH_SECRET_NAMES = ["FCM_SERVICE_ACCOUNT", "FIREBASE_CLIENT_CONFIG"];

export const PUSH_PREREQUISITES = [
  "Push notifications (Firebase Cloud Messaging, free) need these things from Google. Have them ready:",
  `  1. A Firebase project (console.firebase.google.com) with an Android app registered for the package ${ANDROID_PACKAGE};`,
  "     download its google-services.json.",
  "  2. A service account for that project with the Firebase Cloud Messaging API Admin role (Google Cloud -> IAM),",
  "     and its JSON key file. This file is the sending key: keep it private.",
  "  See server/README.md, Push notifications.",
];

const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error });

const PROJECT_ID = /^[a-z][a-z0-9-]{4,}$/;
const CLIENT_RULES = {
  apiKey: [/^[\w-]{20,100}$/, "apiKey must be 20-100 letters, digits, - or _ (google-services.json: client[0].api_key[0].current_key)"],
  appId: [/^\d+:\d+:android:[0-9a-f]+$/, "appId must look like 1:1234567890:android:abcdef (client[0].client_info.mobilesdk_app_id)"],
  projectId: [PROJECT_ID, "projectId must be a Firebase project ID such as my-project-1234 (project_info.project_id)"],
  senderId: [/^\d{5,20}$/, "senderId must be 5-20 digits (project_info.project_number)"],
};

function parseObject(raw, what) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return fail(`${what} is not valid JSON.`);
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? ok(parsed) : fail(`${what} must contain a JSON object.`);
}

/** One of apiKey | appId | projectId | senderId. */
export function parseFirebaseField(key, raw) {
  const v = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  return CLIENT_RULES[key][0].test(v) ? ok(v) : fail(`${CLIENT_RULES[key][1]}.`);
}

/** The four public Firebase identifiers, validated; returns { apiKey, appId, projectId, senderId } in that order. */
export function parseFirebaseClientConfig(input) {
  const out = {};
  for (const key of Object.keys(CLIENT_RULES)) {
    const r = parseFirebaseField(key, input?.[key]);
    if (!r.ok) return r;
    out[key] = r.value;
  }
  return ok(out);
}

/** Service-account key file text -> { json (compact text, SECRET), projectId, privateKey (SECRET, for masking) }. */
export function parseServiceAccount(raw) {
  const r = parseObject(raw, "The service-account file");
  if (!r.ok) return r;
  const a = r.value;
  for (const key of ["client_email", "private_key", "project_id"]) {
    if (typeof a[key] !== "string" || a[key].trim() === "") return fail(`The service-account file has no "${key}". Download a JSON key for the service account (Google Cloud -> IAM -> Service accounts -> Keys).`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.client_email)) return fail('"client_email" in the service-account file is not an email address.');
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(a.private_key)) return fail('"private_key" in the service-account file is not a PEM private key.');
  if (!PROJECT_ID.test(a.project_id)) return fail('"project_id" in the service-account file is not a valid Firebase project ID.');
  return ok({ json: JSON.stringify(a), projectId: a.project_id, privateKey: a.private_key });
}

/** google-services.json text -> validated client config. Picks the client registered for the Linekeep package. */
export function parseGoogleServices(raw) {
  const r = parseObject(raw, "google-services.json");
  if (!r.ok) return r;
  const clients = Array.isArray(r.value.client) ? r.value.client : [];
  const client = clients.find((c) => c?.client_info?.android_client_info?.package_name === ANDROID_PACKAGE);
  if (!client) {
    return fail(`google-services.json has no Android app for the package ${ANDROID_PACKAGE}. Register an Android app with exactly that package in Firebase and download the file again.`);
  }
  return parseFirebaseClientConfig({
    apiKey: client.api_key?.[0]?.current_key,
    appId: client.client_info?.mobilesdk_app_id,
    projectId: r.value.project_info?.project_id,
    senderId: r.value.project_info?.project_number,
  });
}

/** Compact JSON for the FIREBASE_CLIENT_CONFIG secret (the shape GET /v1/device/push-config serves). */
export const serializeClientConfig = (config) => JSON.stringify({ apiKey: config.apiKey, appId: config.appId, projectId: config.projectId, senderId: config.senderId });

/** `~/x` -> $HOME/x; other paths unchanged. */
export function expandHome(path, home) {
  const v = String(path ?? "").trim();
  return home && (v === "~" || v.startsWith("~/")) ? `${home}${v.slice(1)}` : v;
}

/** Reads a file through the injected fs. The path (not the contents) is the only thing an error may mention. */
export function readFileText(fs, path, home) {
  const target = expandHome(path, home);
  if (!target) return fail("Enter a file path.");
  try {
    return ok(fs.read(target));
  } catch {
    return fail(`Could not read "${target}". Check the path and that the file is readable.`);
  }
}
