import { z } from "zod";

import type { Env } from "../env";
import { parseRecipients } from "../settings/fields";

const domainPattern = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

export interface MailConfiguration {
  recipients: string[];
  domain: string;
  key: string;
  sender: string;
  region: "us" | "eu";
}

/** The Mailgun settings, or null when any is missing or invalid. Zod/provider errors can carry private values, so none is surfaced. */
export function mailConfiguration(env: Pick<Env, "EMAIL_IDS" | "MAILGUN_DOMAIN" | "MAILGUN_API_KEY" | "MAILGUN_FROM_EMAIL" | "MAILGUN_REGION">): MailConfiguration | null {
  try {
    const recipients = parseRecipients(env.EMAIL_IDS);
    if (!recipients) return null;
    const domain = z.string().max(253).regex(domainPattern).parse(env.MAILGUN_DOMAIN);
    return {
      recipients,
      domain,
      key: z.string().trim().min(1).parse(env.MAILGUN_API_KEY),
      sender: z.email().parse(env.MAILGUN_FROM_EMAIL ?? `postmaster@${domain}`),
      region: z.enum(["us", "eu"]).parse(env.MAILGUN_REGION ?? "us"),
    };
  } catch {
    return null;
  }
}

/** Names (never values) of the Mailgun settings that stop an email from being sent. */
export function mailProblems(env: Pick<Env, "EMAIL_IDS" | "MAILGUN_DOMAIN" | "MAILGUN_API_KEY" | "MAILGUN_FROM_EMAIL" | "MAILGUN_REGION">): string[] {
  const problems: string[] = [];
  if (!parseRecipients(env.EMAIL_IDS)) problems.push("recipients");
  if (!domainPattern.test(env.MAILGUN_DOMAIN ?? "")) problems.push("domain");
  if (!env.MAILGUN_API_KEY?.trim()) problems.push("API key");
  if (env.MAILGUN_FROM_EMAIL !== undefined && !z.email().safeParse(env.MAILGUN_FROM_EMAIL).success) problems.push("from address");
  if (env.MAILGUN_REGION !== undefined && env.MAILGUN_REGION !== "us" && env.MAILGUN_REGION !== "eu") problems.push("region");
  return problems;
}

type MailEnv = Pick<Env, "EMAIL_IDS" | "MAILGUN_DOMAIN" | "MAILGUN_API_KEY" | "MAILGUN_FROM_EMAIL" | "MAILGUN_REGION">;

/**
 * The Mailgun account alone (domain, API key, sender, region), for mail that is not the daily summary and so has
 * no fixed recipient list. Null when any is missing or invalid.
 */
export function mailTransport(env: MailEnv): Omit<MailConfiguration, "recipients"> | null {
  const configuration = mailConfiguration({ ...env, EMAIL_IDS: '["transport@example.com"]' });
  if (!configuration) return null;
  const { recipients: _unused, ...transport } = configuration;
  return transport;
}

/** Names (never values) of the Mailgun settings that stop `mailTransport` from being usable. */
export function mailTransportProblems(env: MailEnv): string[] {
  return mailProblems({ ...env, EMAIL_IDS: '["transport@example.com"]' });
}

/** Posts one message to Mailgun. Rejects with HTTP status only; the response body is discarded. */
export async function sendMail(config: MailConfiguration, message: { fromName: string; subject: string; text: string; html: string }): Promise<void> {
  const body = new FormData();
  body.set("from", `${message.fromName} <${config.sender}>`);
  for (const recipient of config.recipients) body.append("to", recipient);
  body.set("subject", message.subject);
  body.set("text", message.text);
  body.set("html", message.html);
  body.set("o:tracking", "no");
  body.set("o:tracking-clicks", "no");
  body.set("o:tracking-opens", "no");
  const host = config.region === "eu" ? "api.eu.mailgun.net" : "api.mailgun.net";
  const response = await fetch(`https://${host}/v3/${config.domain}/messages`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`api:${config.key}`)}` },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {
    throw new MailError(0);
  });
  await response.body?.cancel();
  if (response.status !== 200) throw new MailError(response.status);
}

export class MailError extends Error {
  constructor(readonly status: number) {
    super(status === 0 ? "Call-summary email request failed" : `Call-summary email was not accepted (HTTP ${status})`);
  }
}
