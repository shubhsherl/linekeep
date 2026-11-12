/**
 * What the activity log may contain. Every event is a (category, action) pair from this catalog, and only the detail
 * keys listed for that pair are kept: whatever else a caller passes is dropped, so message text, notes, phone
 * numbers, codes and file contents cannot reach the table by accident.
 */
export const activityCategories = ["signin", "device", "customer", "whatsapp", "call", "admin"] as const;
export type ActivityCategory = (typeof activityCategories)[number];

export const activityChannels = ["app", "web", "admin", "system"] as const;
export type ActivityChannel = (typeof activityChannels)[number];

export const activityActorTypes = ["employee", "admin", "system", "customer"] as const;
export type ActivityActorType = (typeof activityActorTypes)[number];

export const activityTargetTypes = ["customer", "employee", "device", "call", "template"] as const;
export type ActivityTargetType = (typeof activityTargetTypes)[number];

/** Allowed detail keys per action. See server/README.md ("Activity log") for what each one means. */
export const activityCatalog = {
  signin: {
    code_requested: ["method"],
    signed_in: ["method"],
    sign_in_failed: ["method", "reason"],
    signed_out: [],
    rate_limited: ["method", "limit"],
    session_revoked: ["count"],
  },
  device: {
    enrolled: ["model", "androidVersion", "appVersion", "recovered"],
    revoked: [],
    recovery_invited: [],
    reassigned: ["toEmployee"],
    invitation_created: [],
    invitation_revoked: [],
    call_sync: ["calls", "batches", "since"],
    recording_uploaded: ["count", "bytes", "since"],
    app_version_changed: ["from", "to"],
  },
  customer: {
    created: ["source", "assigned"],
    updated: ["fields"],
    assigned: ["employees"],
    unassigned: ["employees"],
    archived: [],
  },
  whatsapp: {
    message_sent: ["type", "templateName", "mediaKind"],
    message_failed: ["type", "templateName", "mediaKind"],
    attachment_uploaded: ["kind", "bytes"],
    message_received: ["type"],
    auto_reply_sent: ["type", "templateName"],
    bulk_intro_sent: ["sent", "failed", "skipped", "templateName"],
  },
  call: {
    recording_played: ["callId"],
    call_log_deleted: [],
    recording_deleted: [],
  },
  admin: {
    employee_created: [],
    employee_updated: ["fields"],
    settings_saved: ["section", "keys"],
    settings_imported: ["keys"],
    template_cache_refreshed: ["count"],
    auto_replies_changed: ["change"],
    quick_messages_changed: ["change"],
    template_images_changed: ["change", "template"],
  },
} as const satisfies Record<ActivityCategory, Record<string, readonly string[]>>;

export function isKnownAction(category: string, action: string): boolean {
  const actions = (activityCatalog as Record<string, Record<string, readonly string[]> | undefined>)[category];
  return actions !== undefined && Object.hasOwn(actions, action);
}

export type DetailValue = string | number | boolean | string[];

const MAX_TEXT = 120;
const MAX_LIST_ITEMS = 20;
const MAX_LIST_TEXT = 80;

/**
 * A name that is only a phone number (WhatsApp creates customers that way) is shown as "••••" and its last four
 * characters; everything else is cut to a sane length. Applied to every stored name and string fact.
 */
export function safeText(value: string, max = MAX_TEXT): string {
  const text = value.trim().slice(0, max);
  return !/[A-Za-z]/.test(text) && (text.match(/\d/g)?.length ?? 0) >= 7 ? `••••${text.slice(-4)}` : text;
}

/** Keeps only the allowed keys of `details` with flat, bounded values. */
export function cleanDetails(category: string, action: string, details: Record<string, unknown> | undefined): Record<string, DetailValue> {
  const allowed = (activityCatalog as Record<string, Record<string, readonly string[]> | undefined>)[category]?.[action] ?? [];
  const clean: Record<string, DetailValue> = {};
  for (const key of allowed) {
    const value = details?.[key];
    if (typeof value === "string") {
      if (value.trim() !== "") clean[key] = safeText(value, key === "since" ? 40 : MAX_TEXT);
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) clean[key] = value;
    } else if (typeof value === "boolean") {
      clean[key] = value;
    } else if (Array.isArray(value)) {
      const items = value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
        .slice(0, MAX_LIST_ITEMS).map((item) => safeText(item, MAX_LIST_TEXT));
      if (items.length > 0) clean[key] = items;
    }
  }
  return clean;
}
