import type { Env } from "../../env";
import { ApiError } from "../../http/errors";
import { mailTransportProblems } from "../../reporting/mail";
import { employeeWebKeys, readEmployeeWeb, usableMethods, whatsappOtpReady, whatsappProblems, type EmployeeWebSettings, type WhatsAppTemplateSetting } from "../../settings/employee-web";
import type { SettingsSnapshot } from "../../settings/service";
import type { SettingChange } from "../../settings/store";
import { whatsappConfig } from "../../whatsapp/cloud";
import { findTemplate } from "../../whatsapp/template-cache";
import type { WhatsAppTemplate } from "../../whatsapp/templates";

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

/** Longest sentence for the code's variable. */
export const SENTENCE_MAX_LENGTH = 200;

/** Why a (trimmed) sentence cannot go into a template variable, or null. Meta rejects line breaks, tabs and long runs of spaces there. */
export function sentenceProblem(sentence: string): string | null {
  if (!sentence) return "The sentence is empty; write a sentence that contains {{code}} where the 6-digit code goes";
  if (sentence.length > SENTENCE_MAX_LENGTH) return `The sentence is ${sentence.length} characters; keep it to ${SENTENCE_MAX_LENGTH} or fewer`;
  if (/[\r\n\t]/.test(sentence)) return "WhatsApp does not allow line breaks or tabs inside a template variable; write the sentence on one line";
  if (/ {4,}/.test(sentence)) return "WhatsApp does not allow four or more spaces in a row inside a template variable";
  if (!sentence.includes("{{code}}")) return "The sentence must contain {{code}} where the 6-digit code goes";
  return null;
}

/** The template setting as stored: the sentence is trimmed and checked when on, and dropped when off. */
export function normalisedTemplate(setting: WhatsAppTemplateSetting): WhatsAppTemplateSetting {
  const { sentence: typed, sentenceEnabled, ...rest } = setting;
  if (sentenceEnabled !== true) return { ...rest, sentenceEnabled: false };
  const sentence = (typed ?? "").trim();
  const problem = sentenceProblem(sentence);
  if (problem) throw new ApiError(400, "invalid_sentence", problem);
  return { ...rest, sentenceEnabled: true, sentence };
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
    const value = input.whatsappTemplate ? normalisedTemplate(input.whatsappTemplate) : null;
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
    let found: WhatsAppTemplate | undefined;
    try {
      found = await findTemplate(env, config, next.whatsappTemplate.name, next.whatsappTemplate.language);
    } catch {
      throw new ApiError(502, "WHATSAPP_SEND_FAILED", "WhatsApp templates could not be loaded; try again in a moment");
    }
    const problem = templateProblem(found, next.whatsappTemplate);
    if (problem) throw invalid(problem);
  }
  if (next.enabled && usableMethods(env, next).length === 0) {
    const mail = mailTransportProblems(env);
    const whatsapp = whatsappProblems(env, next.whatsappTemplate);
    const email = !next.emailOtp ? "switched off" : mail.length > 0 ? `missing ${mail.join(", ")}` : "ready";
    const wa = !next.whatsappOtp ? "switched off" : whatsapp.length > 0 ? `missing ${whatsapp.join(", ")}` : "ready";
    throw new ApiError(400, "no_sign_in_method", `Turn on at least one sign-in method first. Email code: ${email}. WhatsApp code: ${wa}.`);
  }
  return changes;
}
