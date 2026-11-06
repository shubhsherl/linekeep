import { createWhatsAppAttachmentRepository } from "../data/whatsapp-attachments";
import type { Env } from "../env";

const day = 24 * 60 * 60 * 1000;
const batchSize = 50;
const maxBatches = 10;

/**
 * Deletes staged WhatsApp files that were uploaded more than two days ago and were never sent or made a template's
 * default header. Files a message or a template default points at are kept. Returns how many were removed.
 */
export async function purgeStaleAttachments(env: Pick<Env, "DB" | "RECORDINGS">, now: number = Date.now()): Promise<number> {
  const repository = createWhatsAppAttachmentRepository(env.DB);
  const cutoff = new Date(now - 2 * day).toISOString();
  let removed = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const stale = await repository.unreferenced(cutoff, batchSize);
    if (stale.length === 0) break;
    // The bucket first: a failure leaves the rows so the next run retries. Deleting a missing key succeeds.
    await env.RECORDINGS.delete(stale.map((file) => file.objectKey));
    await repository.deleteRows(stale.map((file) => file.id));
    removed += stale.length;
  }
  return removed;
}
