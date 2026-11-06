import { z } from "zod";

/** The Firebase app's public client identifiers, handed to enrolled phones. */
export const firebaseClientConfig = z.strictObject({
  apiKey: z.string().regex(/^[\w-]{20,100}$/),
  appId: z.string().regex(/^\d+:\d+:android:[0-9a-f]+$/),
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,}$/),
  senderId: z.string().regex(/^\d{5,20}$/),
});

export type FirebaseClientConfig = z.infer<typeof firebaseClientConfig>;

/** The public Firebase identifiers for phones, or null when push is not set up or the setting is malformed. */
export function pushClientConfig(raw: string | undefined): FirebaseClientConfig | null {
  try {
    const parsed = firebaseClientConfig.safeParse(raw ? JSON.parse(raw) : null);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
