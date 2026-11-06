import type { Context } from "hono";

/** Runs follow-up work after the response when the platform allows it (Workers), otherwise waits for it (tests, Node). */
export async function defer(context: Context, work: Promise<unknown>): Promise<void> {
  try {
    context.executionCtx.waitUntil(work);
  } catch {
    await work;
  }
}
