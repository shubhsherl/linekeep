import { z } from "zod";

import type { Env } from "../env";
import { mailTransport } from "../reporting/mail";
import { whatsappConfig } from "../whatsapp/cloud";

/** Settings of the employee web app (/app). They have no deployment-variable counterpart and hold no secrets. */
export const employeeWebKeys = {
  enabled: "employeeWeb.enabled",
  emailOtp: "employeeWeb.emailOtp",
  whatsappOtp: "employeeWeb.whatsappOtp",
  whatsappTemplate: "employeeWeb.whatsappTemplate",
} as const;

const bodyVariable = z.number().int().min(1).max(30);

/** How the sign-in code is placed into an approved WhatsApp template. */
export const whatsappTemplateSetting = z.strictObject({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().regex(/^[A-Za-z]{2,3}(?:_[A-Za-z0-9]{2,8})?$/),
  /** 1-based position of the body variable that receives the code. */
  otpParam: bodyVariable,
  otherParams: z.array(z.strictObject({
    index: bodyVariable,
    source: z.enum(["employee_name", "custom"]),
    value: z.string().trim().min(1).max(200).optional(),
  })).max(30),
  /** Authentication templates: also send the code as the button parameter. */
  buttonParam: z.boolean().optional(),
});
export type WhatsAppTemplateSetting = z.infer<typeof whatsappTemplateSetting>;

export type OtpMethod = "email" | "whatsapp";

export interface EmployeeWebSettings {
  enabled: boolean;
  emailOtp: boolean;
  whatsappOtp: boolean;
  whatsappTemplate: WhatsAppTemplateSetting | null;
}

const flag = (values: ReadonlyMap<string, string>, key: string, fallback: boolean): boolean => {
  const value = values.get(key);
  return value === "true" ? true : value === "false" ? false : fallback;
};

/** The stored settings with their defaults: off, email codes on, WhatsApp codes off. */
export function readEmployeeWeb(values: ReadonlyMap<string, string>): EmployeeWebSettings {
  let template: WhatsAppTemplateSetting | null = null;
  const raw = values.get(employeeWebKeys.whatsappTemplate);
  if (raw) {
    try {
      const parsed = whatsappTemplateSetting.safeParse(JSON.parse(raw));
      template = parsed.success ? parsed.data : null;
    } catch {
      template = null;
    }
  }
  return {
    enabled: flag(values, employeeWebKeys.enabled, false),
    emailOtp: flag(values, employeeWebKeys.emailOtp, true),
    whatsappOtp: flag(values, employeeWebKeys.whatsappOtp, false),
    whatsappTemplate: template,
  };
}

type MailEnv = Pick<Env, "EMAIL_IDS" | "MAILGUN_DOMAIN" | "MAILGUN_API_KEY" | "MAILGUN_FROM_EMAIL" | "MAILGUN_REGION">;
type WhatsAppEnv = Pick<Env, "WHATSAPP_TOKEN" | "WHATSAPP_PHONE_NUMBER_ID" | "WHATSAPP_GRAPH_VERSION" | "WHATSAPP_WABA_ID">;

export const emailOtpReady = (env: MailEnv) => mailTransport(env) !== null;
/** Template lookups and sends need the account id as well as the token and number. */
export const whatsappOtpReady = (env: WhatsAppEnv) => whatsappConfig(env)?.wabaId != null;

/** The sign-in methods a visitor can use right now: switched on and with their prerequisites in place. */
export function usableMethods(env: Env, settings: EmployeeWebSettings): OtpMethod[] {
  const methods: OtpMethod[] = [];
  if (settings.emailOtp && emailOtpReady(env)) methods.push("email");
  if (settings.whatsappOtp && settings.whatsappTemplate && whatsappOtpReady(env)) methods.push("whatsapp");
  return methods;
}

/** Names (never values) of what stops WhatsApp codes from being sent; empty when they can be. */
export function whatsappProblems(env: WhatsAppEnv, template: WhatsAppTemplateSetting | null): string[] {
  const problems: string[] = [];
  if (!env.WHATSAPP_TOKEN?.trim()) problems.push("access token");
  if (!/^\d{5,32}$/.test(env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? "")) problems.push("phone number ID");
  if (!/^\d{5,32}$/.test(env.WHATSAPP_WABA_ID?.trim() ?? "")) problems.push("business account ID");
  if (!template) problems.push("template");
  return problems;
}

/** Web sign-in is on only when an administrator allowed it and at least one method can actually deliver a code. */
export function employeeWebActive(env: Env, settings: EmployeeWebSettings): boolean {
  return settings.enabled && usableMethods(env, settings).length > 0;
}
