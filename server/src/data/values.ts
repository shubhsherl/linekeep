import { z } from "zod";

export const id = z.string().min(1);
export const utcTimestamp = z.iso
  .datetime()
  .transform((value) => new Date(value).toISOString());
export const positiveInteger = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const nonnegativeInteger = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export type Clock = () => Date;

export function timestamp(clock: Clock): string {
  return utcTimestamp.parse(clock().toISOString());
}

export function opaqueId(prefix: "emp" | "inv" | "dev" | "call"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
