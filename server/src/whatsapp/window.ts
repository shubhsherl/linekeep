/** WhatsApp lets a business send free-form messages for 24 hours after the customer's last message. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WhatsAppWindow { open: boolean; expiresAt: string | null }

/** The state of the free-message window from the customer's latest inbound message; `expiresAt` is set only while it is open. */
export function whatsappWindow(lastInboundAt: string | null, now: number = Date.now()): WhatsAppWindow {
  const received = lastInboundAt === null ? NaN : Date.parse(lastInboundAt);
  const expires = received + WINDOW_MS;
  return Number.isFinite(received) && expires > now ? { open: true, expiresAt: new Date(expires).toISOString() } : { open: false, expiresAt: null };
}
