import type { Env } from "../../env";
import { ApiError } from "../../http/errors";
import { mailTransportProblems } from "../../reporting/mail";
import { employeeWebKeys, readEmployeeWeb, usableMethods, whatsappOtpReady, type EmployeeWebSettings, type WhatsAppTemplateSetting } from "../../settings/employee-web";
import type { SettingsSnapshot } from "../../settings/service";
import type { SettingChange } from "../../settings/store";
import { whatsappConfig } from "../../whatsapp/cloud";
import { fetchTemplates, type WhatsAppTemplate } from "../../whatsapp/templates";

export interface EmployeeWebInput {
  enabled?: boolean | null;
  emailOtp?: boolean | null;
  whatsappOtp?: boolean | null;
  whatsappTemplate?: WhatsAppTemplateSetting | null;
}

const invalid = (message: string) => new ApiError(400, "INVALID_REQUEST", message);

/** Why a template cannot carry the sign-in code, or null when it can. */
export function templateProblem(template: WhatsAppTemplate | undefined, setting: WhatsAppTemplateSetting): string | null {
  if (!template) return "That template was not found among the approved templates of the WhatsApp account";
  if (!template.otpCapable) {
    return template.sendable
      ? "That template cannot carry a sign-in code: it needs a text-only header and at least one body variable"
      : `That template cannot be used: ${template.reason ?? "it is not supported"}`;
  }
  const count = template.variables.length;
  if (setting.otpParam > count) return `The code variable {{${setting.otpParam}}} does not exist: the template has ${count} body variable${count === 1 ? "" : "s"}`;
  const others = new Map<number, WhatsAppTemplateSetting["otherParams"][number]>();
  for (const param of setting.otherParams) {
    if (param.index === setting.otpParam) return "The code variable cannot also be filled with another value";
    if (param.index > count) return `Variable {{${param.index}}} does not exist: the template has ${count} body variable${count === 1 ? "" : "s"}`;
    if (others.has(param.index)) return `Variable {{${param.index}}} is set twice`;
    if (param.source === "custom" && !param.value) return `Variable {{${param.index}}} needs a value`;
    others.set(param.index, param);
  }
  for (let index = 1; index <= count; index++) {
    if (index !== setting.otpParam && !others.has(index)) return `Variable {{${index}}} needs a value`;
  }
  const authentication = template.buttons?.some((button) => button.type === "OTP") ?? false;
  if (authentication && setting.buttonParam !== true) return "Authentication templates also need the code as the button parameter";
  if (!authentication && setting.buttonParam === true) return "Only authentication templates take the code as a button parameter";
  return null;
}

/** Turns a validated employee-web update into stored changes. Throws a 400 naming what is missing. */
export async function employeeWebChanges(env: Env, snapshot: SettingsSnapshot, input: EmployeeWebInput): Promise<SettingChange[]> {
  const changes: SettingChange[] = [];
  const next: EmployeeWebSettings = readEmployeeWeb(snapshot.values);
  const defaults = readEmployeeWeb(new Map());
  for (const name of ["enabled", "emailOtp", "whatsappOtp"] as const) {
    if (!Object.hasOwn(input, name)) continue;
    const value = input[name];
    changes.push({ key: employeeWebKeys[name], value: value === null || value === undefined ? null : String(value) });
    next[name] = value ?? defaults[name];
  }
  const templateChanged = Object.hasOwn(input, "whatsappTemplate");
  if (templateChanged) {
    const value = input.whatsappTemplate ?? null;
    changes.push({ key: employeeWebKeys.whatsappTemplate, value: value === null ? null : JSON.stringify(value) });
    next.whatsappTemplate = value;
  }

  const emailAsked = input.emailOtp === true;
  const whatsappAsked = input.whatsappOtp === true || (templateChanged && next.whatsappOtp);
  if (emailAsked && next.emailOtp) {
    const missing = mailTransportProblems(env);
    if (missing.length > 0) {
      throw invalid(`Email sign-in needs the email settings first: check the ${missing.join(", ")} in Config > Email.`);
    }
  }
  if (next.whatsappOtp && (whatsappAsked || input.enabled === true)) {
    if (!next.whatsappTemplate) throw invalid("WhatsApp sign-in needs a template: choose one first");
    const config = whatsappConfig(env);
    if (!config || !whatsappOtpReady(env)) {
      throw invalid("WhatsApp sign-in needs the WhatsApp access token, phone number id and business account id in Config > WhatsApp.");
    }
    let templates: WhatsAppTemplate[];
    try {
      templates = await fetchTemplates(config, { name: next.whatsappTemplate.name });
    } catch {
      throw new ApiError(502, "WHATSAPP_SEND_FAILED", "WhatsApp templates could not be loaded; try again in a moment");
    }
    const problem = templateProblem(templates.find((item) => item.language === next.whatsappTemplate!.language), next.whatsappTemplate);
    if (problem) throw invalid(problem);
  }
  if (next.enabled && usableMethods(env, next).length === 0) {
    throw invalid("Set up email or WhatsApp sign-in first: employees need at least one way to receive a code.");
  }
  return changes;
}
