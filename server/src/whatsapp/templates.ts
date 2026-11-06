import { WhatsAppSendError, type WhatsAppConfig } from "./cloud";

export interface TemplateButton { type: string; text: string }
export interface TemplateVariable { key: string; example?: string }
export type HeaderFormat = "NONE" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
export interface WhatsAppTemplate {
  name: string; language: string; category: string;
  /** What the header carries; media headers (IMAGE, VIDEO, DOCUMENT) need a file at send time. */
  headerFormat: HeaderFormat;
  header?: string; body: string; footer?: string; buttons?: TemplateButton[];
  /** Body placeholders in order of appearance; `named` templates send the key as the parameter name. */
  variables: TemplateVariable[]; named: boolean;
  sendable: boolean; reason?: string;
}

type Component = {
  type?: string; format?: string; text?: string;
  example?: { body_text?: string[][]; body_text_named_params?: { param_name?: string; example?: string }[] };
  buttons?: { type?: string; text?: string; url?: string }[];
};
type RawTemplate = { name?: string; language?: string; status?: string; category?: string; parameter_format?: string; components?: Component[] };

const placeholder = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const supportedButtons = new Set(["QUICK_REPLY", "PHONE_NUMBER", "URL"]);

function variablesOf(text: string, component: Component | undefined): TemplateVariable[] {
  const examples = new Map<string, string>();
  (component?.example?.body_text_named_params ?? []).forEach((item) => {
    if (item.param_name && item.example) examples.set(item.param_name, item.example);
  });
  (component?.example?.body_text?.[0] ?? []).forEach((value, index) => examples.set(String(index + 1), value));
  const seen = new Set<string>();
  const result: TemplateVariable[] = [];
  for (const match of text.matchAll(placeholder)) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    const example = examples.get(match[1]);
    result.push(example ? { key: match[1], example } : { key: match[1] });
  }
  return result;
}

/** Turns Meta's component list into what the admin needs, flagging templates this app cannot send yet. */
export function normalizeTemplate(raw: RawTemplate): WhatsAppTemplate | null {
  if (typeof raw.name !== "string" || typeof raw.language !== "string") return null;
  const components = Array.isArray(raw.components) ? raw.components : [];
  const find = (type: string) => components.find((component) => component.type === type);
  const header = find("HEADER"), body = find("BODY"), footer = find("FOOTER"), buttons = find("BUTTONS");
  const bodyText = typeof body?.text === "string" ? body.text : "";
  let reason: string | undefined;
  if (components.some((component) => !["HEADER", "BODY", "FOOTER", "BUTTONS"].includes(component.type ?? ""))) {
    reason = "Carousel and other rich templates are not supported yet";
  } else if (header && !["TEXT", "IMAGE", "VIDEO", "DOCUMENT"].includes(header.format ?? "")) {
    reason = "Templates with a location or other special header are not supported yet";
  } else if (header?.text && /\{\{/.test(header.text)) {
    reason = "Templates with header variables are not supported yet";
  } else if (buttons?.buttons?.some((button) => !supportedButtons.has(button.type ?? "") || /\{\{/.test(button.url ?? ""))) {
    reason = "Templates with dynamic or special buttons are not supported yet";
  } else if (!bodyText) {
    reason = "Template has no text body";
  }
  const shown = (component: Component | undefined) => typeof component?.text === "string" && component.text ? component.text : undefined;
  const headerFormat = (header ? header.format : "NONE") as HeaderFormat;
  return {
    name: raw.name, language: raw.language, category: raw.category ?? "", headerFormat,
    header: headerFormat === "TEXT" ? shown(header) : undefined, body: bodyText, footer: shown(footer),
    buttons: buttons?.buttons?.flatMap((button) => button.text ? [{ type: button.type ?? "", text: button.text }] : []),
    variables: variablesOf(bodyText, body), named: raw.parameter_format === "NAMED",
    sendable: reason === undefined, ...(reason ? { reason } : {}),
  };
}

/** Approved templates of the account, optionally narrowed by name. */
export async function fetchTemplates(config: WhatsAppConfig, filter: { name?: string } = {}): Promise<WhatsAppTemplate[]> {
  if (!config.wabaId) throw new WhatsAppSendError(0, null, false);
  const query = new URLSearchParams({
    fields: "name,language,status,category,parameter_format,components", limit: "100", status: "APPROVED",
    ...(filter.name ? { name: filter.name } : {}),
  });
  let response: Response;
  try {
    response = await fetch(`https://graph.facebook.com/${config.version}/${config.wabaId}/message_templates?${query}`, {
      headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new WhatsAppSendError(0, null, true);
  }
  const parsed = await response.json().catch(() => null) as { data?: RawTemplate[] } | null;
  if (!response.ok || !Array.isArray(parsed?.data)) {
    throw new WhatsAppSendError(response.status, null, response.status >= 500 || response.status === 429);
  }
  return parsed.data.filter((raw) => raw.status === "APPROVED")
    .flatMap((raw) => { const template = normalizeTemplate(raw); return template ? [template] : []; })
    .sort((a, b) => Number(b.sendable) - Number(a.sendable) || a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}

/** The exact text the customer sees: header, body and footer with variables filled in. */
export function renderTemplate(template: WhatsAppTemplate, values: string[]): string {
  const byKey = new Map(template.variables.map((variable, index) => [variable.key, values[index] ?? ""]));
  const fill = (text: string) => text.replace(placeholder, (_, key: string) => byKey.get(key) ?? "");
  return [template.header, template.body, template.footer].filter((part): part is string => !!part).map(fill).join("\n");
}
