import { z } from "zod";
import { HTTPException } from "hono/http-exception";

import {
  createWhatsAppAttachmentRepository, type Attachment, type AttachmentOwner,
} from "../../data/whatsapp-attachments";
import { createWhatsAppRepository } from "../../data/whatsapp";
import type { Env } from "../../env";
import {
  sendCloudMessage, WhatsAppSendError, type CloudMedia, type WhatsAppConfig,
} from "../../whatsapp/cloud";
import { fetchTemplates, renderTemplate, type WhatsAppTemplate } from "../../whatsapp/templates";
import {
  headerFile, metaMedia, staleMediaErrors, TemplateHeaderRequiredError, WhatsAppSendFailedError, WhatsAppUnavailableError,
} from "./send";

/** Intro sends in flight at once. */
export const INTRO_CONCURRENCY = 3;

/** A template variable: a field of the new customer or its handler, or one fixed text for every row. */
const introParam = z.union([
  z.strictObject({ source: z.enum(["customer_name", "handler_name", "handler_phone"]) }),
  z.strictObject({ value: z.string().trim().min(1).max(1024).regex(/^[^\n\r\t]*$/) }),
]);
export type IntroParam = z.infer<typeof introParam>;

export const introInput = z.strictObject({
  template: z.strictObject({
    name: z.string().regex(/^[a-z0-9_]{1,512}$/),
    language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/).default("en_US"),
    params: z.array(introParam).max(20).default([]),
    headerAttachmentId: z.string().regex(/^wat_[A-Za-z0-9_-]{1,64}$/).optional(),
  }),
});
export type IntroInput = z.infer<typeof introInput>;

export interface IntroResult { status: "sent" | "failed" | "skipped"; reason?: string }
export interface IntroTarget {
  customerId: string; name: string; phone: string; handler: { name: string; phone: string } | null;
}

export interface PreparedIntro {
  config: WhatsAppConfig; template: WhatsAppTemplate; params: IntroParam[];
  /** The file shown in the header; undefined for templates without a media header or when none is available. */
  file: Attachment | undefined;
  /** The template needs a media header and neither an override nor a default file exists. */
  headerMissing: boolean;
  needsHandler: boolean;
}

/**
 * Looks the template up once (one Meta call) and checks the header file; nothing is created yet, so a bad template, a bad
 * override file or a Meta outage stops the whole request. Throws the same errors as a normal template send.
 */
export async function prepareIntro(env: Env, config: WhatsAppConfig, intro: IntroInput, owner: AttachmentOwner): Promise<PreparedIntro> {
  if (!config.wabaId) throw new WhatsAppUnavailableError();
  const wanted = intro.template;
  let template: WhatsAppTemplate | undefined;
  try {
    template = (await fetchTemplates(config, { name: wanted.name })).find((item) => item.language === wanted.language);
  } catch (error) {
    throw new WhatsAppSendFailedError(error instanceof WhatsAppSendError ? error.retryable : true);
  }
  if (!template) throw new HTTPException(404, { message: "Template not found" });
  if (!template.sendable || wanted.params.length !== template.variables.length) {
    throw new HTTPException(400, { message: "Template cannot be sent with these values" });
  }
  let file: Attachment | undefined;
  let headerMissing = false;
  try {
    file = await headerFile(env, template, wanted.headerAttachmentId, owner);
  } catch (error) {
    if (!(error instanceof TemplateHeaderRequiredError)) throw error;
    headerMissing = true;
  }
  return {
    config, template, params: wanted.params, file, headerMissing,
    needsHandler: wanted.params.some((param) => "source" in param && param.source !== "customer_name"),
  };
}

/** The values of one row, or the reason it cannot be messaged. */
function resolveParams(params: IntroParam[], target: IntroTarget): { values: string[] } | { reason: string } {
  const values: string[] = [];
  for (const param of params) {
    let value: string;
    if ("value" in param) value = param.value;
    else if (param.source === "customer_name") value = target.name;
    else if (!target.handler) return { reason: "no_handler" };
    else value = param.source === "handler_name" ? target.handler.name : target.handler.phone;
    // Meta refuses empty values and line breaks inside a variable.
    value = value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 1024);
    if (value === "") return { reason: "missing_value" };
    values.push(value);
  }
  return { values };
}

/** A short fixed reason; Meta's own wording and details are never passed on. */
function failureReason(error: unknown): string {
  if (!(error instanceof WhatsAppSendError)) return "send_failed";
  if (error.code === 131026) return "not_on_whatsapp";
  if (error.status === 429 || (error.code !== null && [130429, 131048, 131056, 80007].includes(error.code))) return "rate_limited";
  return "send_failed";
}

/** The header file as Meta knows it. A cached id Meta no longer accepts is replaced once for the whole batch. */
class HeaderMedia {
  private generation = 0;
  private refreshing: Promise<void> | null = null;
  private constructor(private media: CloudMedia, private readonly cached: boolean, private readonly redo: () => Promise<CloudMedia>) {}

  static async open(env: Env, config: WhatsAppConfig, file: Attachment, fetches: { count: number }): Promise<HeaderMedia> {
    const first = await metaMedia(env, config, file, false);
    if (!first.cached) fetches.count += 1;
    return new HeaderMedia(first.media, first.cached, async () => {
      await createWhatsAppAttachmentRepository(env.DB).clearMetaMedia(file.id);
      fetches.count += 1;
      return (await metaMedia(env, config, file, true)).media;
    });
  }

  /** Current media; waits for a refresh in progress so no row starts with the id being replaced. */
  async get(): Promise<{ media: CloudMedia; generation: number }> {
    if (this.refreshing) await this.refreshing.catch(() => undefined);
    return { media: this.media, generation: this.generation };
  }

  /** The media to retry with, or null when this failure is not (or no longer) a stale-id problem. Replaces the id at most once. */
  async retryWith(used: number, error: unknown): Promise<CloudMedia | null> {
    if (!(error instanceof WhatsAppSendError) || error.code === null || !staleMediaErrors.has(error.code)) return null;
    if (this.refreshing === null) {
      if (!this.cached) return null;
      this.refreshing = this.redo().then((media) => { this.media = media; this.generation += 1; });
    }
    try {
      await this.refreshing;
    } catch {
      return null;
    }
    return used === this.generation ? null : this.media;
  }
}

/**
 * Sends the intro template to each target, a few at a time. Each message is stored exactly like a normal template send, a failure
 * is confined to its own row, and the returned count of Meta calls lets the caller keep the request under the platform limit.
 */
export async function sendIntros(
  env: Env, prepared: PreparedIntro, targets: IntroTarget[],
): Promise<{ results: IntroResult[]; fetches: number }> {
  const { config, template, params, file } = prepared;
  const fetches = { count: 1 }; // the template lookup in prepareIntro
  const results: IntroResult[] = targets.map(() => ({ status: "failed", reason: "send_failed" }));
  if (prepared.headerMissing) {
    return { results: targets.map(() => ({ status: "failed", reason: "header_image_required" })), fetches: fetches.count };
  }
  const work: { position: number; values: string[] }[] = [];
  targets.forEach((target, position) => {
    const resolved = resolveParams(params, target);
    if ("reason" in resolved) results[position] = { status: "skipped", reason: resolved.reason };
    else work.push({ position, values: resolved.values });
  });
  if (work.length === 0) return { results, fetches: fetches.count };

  let header: HeaderMedia | null = null;
  if (file) {
    try {
      header = await HeaderMedia.open(env, config, file, fetches);
    } catch (error) {
      const reason = failureReason(error);
      for (const item of work) results[item.position] = { status: "failed", reason };
      return { results, fetches: fetches.count + 1 };
    }
  }
  const repository = createWhatsAppRepository(env.DB);
  const content = (values: string[], media?: CloudMedia) => ({
    type: "template" as const, name: template.name, language: template.language, ...(media ? { header: media } : {}),
    params: template.variables.map((variable, index) => ({ key: variable.key, named: template.named, value: values[index] ?? "" })),
  });
  const queue = [...work];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const target = targets[item.position];
      const id = `wam_${crypto.randomUUID()}`;
      try {
        const queued = await repository.queueOutbound({
          id, customerId: target.customerId, to: target.phone, from: null, employeeId: null, type: "template",
          body: renderTemplate(template, item.values), templateName: template.name,
          ...(file ? { media: { key: file.objectKey, mimeType: file.mimeType, fileName: file.fileName, size: file.size } } : {}),
        });
        if (!queued.created) continue;
        try {
          const to = target.phone.replace(/\D/g, "");
          const used = header ? await header.get() : null;
          let externalId: string;
          fetches.count += 1;
          try {
            externalId = await sendCloudMessage(config, to, content(item.values, used?.media));
          } catch (error) {
            const retry = header && used ? await header.retryWith(used.generation, error) : null;
            if (!retry) throw error;
            fetches.count += 1;
            externalId = await sendCloudMessage(config, to, content(item.values, retry));
          }
          await repository.markSent(id, externalId);
          results[item.position] = { status: "sent" };
        } catch (error) {
          await repository.markFailed(id);
          results[item.position] = { status: "failed", reason: failureReason(error) };
        }
      } catch {
        results[item.position] = { status: "failed", reason: "send_failed" };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(INTRO_CONCURRENCY, work.length) }, worker));
  return { results, fetches: fetches.count };
}
