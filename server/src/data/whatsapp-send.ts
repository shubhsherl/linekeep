import { z } from "zod";

const clientMessageId = z.uuid();
const attachmentId = z.string().regex(/^wat_[A-Za-z0-9_-]{1,64}$/);

/**
 * One outbound WhatsApp message: free text, a file (image, video or document with an optional caption) or an approved
 * template. Text and files only work within 24 hours of the customer's last message; a template is the only way to
 * start a conversation or to write after the window has closed.
 */
export const whatsappSendInput = z.union([
  z.strictObject({ clientMessageId, type: z.literal("text").optional(), text: z.string().min(1).max(4096) }),
  z.strictObject({
    clientMessageId,
    type: z.literal("media"),
    attachmentId,
    caption: z.string().trim().min(1).max(1024).optional(),
  }),
  z.strictObject({
    clientMessageId,
    type: z.literal("template").optional(),
    template: z.strictObject({
      name: z.string().regex(/^[a-z0-9_]{1,512}$/),
      language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/).default("en_US"),
      // Values for the body variables, in order. Meta rejects newlines and tabs inside a variable.
      params: z.array(z.string().trim().min(1).max(1024).regex(/^[^\n\r\t]*$/)).max(20).default([]),
      // Replaces the template's default header file for this message only.
      headerAttachmentId: attachmentId.optional(),
    }),
  }),
]);
export type WhatsAppSendInput = z.infer<typeof whatsappSendInput>;
