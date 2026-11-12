import type { SignInEmployee } from "../../data/web-auth";
import type { Env } from "../../env";
import { mailTransport, sendMail, MailError } from "../../reporting/mail";
import type { EmployeeWebSettings } from "../../settings/employee-web";
import { sendOtpTemplate, WhatsAppSendFailedError, WhatsAppUnavailableError } from "../whatsapp/send";
import { LOGIN_CODE_TTL_MS } from "../../data/web-auth";

type Reason = "not_configured" | "no_phone" | "no_template" | "rejected" | "unreachable";

/** One line per delivery with a fixed reason from this list: never the code, the address, or a provider's text. */
function logOutcome(method: "email" | "whatsapp", reason: Reason | null): void {
  console.log(JSON.stringify({ event: "web_sign_in_code", method, delivered: reason === null, ...(reason ? { reason } : {}) }));
}

const minutes = LOGIN_CODE_TTL_MS / 60_000;

/** Sends the code by Mailgun with the account's own sender. Failures are logged by reason only. */
export async function deliverEmailCode(env: Env, to: string, code: string): Promise<void> {
  const transport = mailTransport(env);
  if (!transport) return logOutcome("email", "not_configured");
  const text = `Your Linekeep sign-in code is ${code}.\n\nIt expires in ${minutes} minutes and works once. If you did not ask for it, ignore this email.`;
  try {
    await sendMail({ ...transport, recipients: [to] }, {
      fromName: "Linekeep",
      subject: "Your Linekeep sign-in code",
      text,
      html: `<p>Your Linekeep sign-in code is</p><p style="font-size:24px;letter-spacing:4px"><strong>${code}</strong></p>`
        + `<p>It expires in ${minutes} minutes and works once. If you did not ask for it, ignore this email.</p>`,
    });
    logOutcome("email", null);
  } catch (error) {
    logOutcome("email", error instanceof MailError && error.status !== 0 ? "rejected" : "unreachable");
  }
}

/** Sends the code through the chosen approved WhatsApp template to the employee's own number. */
export async function deliverWhatsAppCode(env: Env, employee: SignInEmployee, settings: EmployeeWebSettings, code: string): Promise<void> {
  const template = settings.whatsappTemplate;
  if (!template) return logOutcome("whatsapp", "no_template");
  if (!employee.phoneNumber) return logOutcome("whatsapp", "no_phone");
  const others = new Map(template.otherParams.map((param) => [param.index, param.source === "employee_name" ? employee.name : param.value ?? ""]));
  try {
    await sendOtpTemplate(env, employee.phoneNumber, {
      name: template.name, language: template.language, otpParam: template.otpParam, otherParams: others,
      buttonParam: template.buttonParam === true,
      ...(template.sentenceEnabled && template.sentence ? { sentence: template.sentence } : {}),
    }, code);
    logOutcome("whatsapp", null);
  } catch (error) {
    logOutcome("whatsapp", error instanceof WhatsAppUnavailableError ? "not_configured"
      : error instanceof WhatsAppSendFailedError && !error.retryable ? "rejected" : "unreachable");
  }
}
