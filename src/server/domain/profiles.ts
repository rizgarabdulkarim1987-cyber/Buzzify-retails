/*
 * Activity profiles: what kind of shop a business is, and which capabilities it starts with.
 * Pure: no database, no I/O. The lists mirror the Prisma enums RtActivityType and Capability.
 */

export const ACTIVITY_TYPES = ["MARKET", "CLOTHING", "ELECTRONICS", "BEAUTY", "STATIONERY", "MIXED"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const CAPABILITIES = [
  "VARIANTS",
  "SERIAL",
  "BATCH",
  "WEIGHT",
  "MULTI_UNIT",
  "WARRANTY",
  "WHOLESALE",
  "LOYALTY",
  "CREDIT",
  "HOLDS",
  "TRANSFERS",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The capabilities a new business of each activity type starts with. */
const DEFAULTS: Readonly<Record<ActivityType, readonly Capability[]>> = Object.freeze({
  MARKET: Object.freeze(["BATCH", "WEIGHT", "MULTI_UNIT", "HOLDS"] as const),
  CLOTHING: Object.freeze(["VARIANTS", "HOLDS"] as const),
  ELECTRONICS: Object.freeze(["SERIAL", "WARRANTY"] as const),
  BEAUTY: Object.freeze(["BATCH", "VARIANTS"] as const),
  STATIONERY: Object.freeze(["MULTI_UNIT"] as const),
  MIXED: Object.freeze(["VARIANTS", "MULTI_UNIT", "BATCH"] as const),
});

/** A fresh copy of the default capabilities for an activity type. */
export function defaultCapabilities(a: ActivityType): Capability[] {
  return [...DEFAULTS[a]];
}

/**
 * Business-level compatibility rules.
 *
 * SERIAL and BATCH together are refused. The spec allows serial tracking on one product and batch
 * tracking on another inside the same business; R0 has no per-product tracking yet, so this is a
 * documented R0 restriction to revisit in R5. Consequence: a MIXED business (which defaults to
 * BATCH) cannot enable SERIAL yet, and an ELECTRONICS business cannot enable BATCH.
 */
export function validateCapabilities(c: readonly Capability[]): { ok: true } | { ok: false; reason: "SERIAL_BATCH_CONFLICT" } {
  if (c.includes("SERIAL") && c.includes("BATCH")) return { ok: false, reason: "SERIAL_BATCH_CONFLICT" };
  return { ok: true };
}
