import { z } from "zod";
import type { RtBusinessStatus } from "@/generated/prisma/client";
import { NotFoundError, RuleError } from "@/server/framework/errors";
import { definePlatformAction } from "@/server/framework/platform-action";
import { updateVersioned } from "@/server/framework/versioned";

/*
 * Business lifecycle and feature overrides (platform admin only). Both demand a written reason
 * of at least 10 characters (after trimming), validated here and backed by a DB CHECK for overrides.
 */

const STATUSES = ["SETUP", "ACTIVE", "SUSPENDED", "ARCHIVED"] as const satisfies readonly RtBusinessStatus[];

/** Allowed moves. ARCHIVED is terminal. */
const TRANSITIONS: Readonly<Record<RtBusinessStatus, readonly RtBusinessStatus[]>> = Object.freeze({
  SETUP: ["ACTIVE"],
  ACTIVE: ["SUSPENDED", "ARCHIVED"],
  SUSPENDED: ["ACTIVE", "ARCHIVED"],
  ARCHIVED: [],
});

export function canTransition(from: RtBusinessStatus, to: RtBusinessStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

const reasonSchema = z.string().trim().min(10).max(500);

export const setBusinessStatus = definePlatformAction({
  name: "platform.business.setStatus",
  input: z.object({
    businessId: z.string().min(1).max(64),
    next: z.enum(STATUSES),
    reason: reasonSchema,
    expectedVersion: z.number().int().min(1),
  }),
  writes: true,
  async run({ tx, input }) {
    const business = await tx.rtBusiness.findUnique({ where: { id: input.businessId }, select: { status: true } });
    if (!business) throw new NotFoundError();
    if (!canTransition(business.status, input.next)) throw new RuleError("INVALID_TRANSITION");
    // Version lock; the status in the where also refuses a move from a status changed meanwhile.
    await updateVersioned(tx.rtBusiness, { id: input.businessId, status: business.status }, input.expectedVersion, {
      status: input.next,
    });
    return { businessId: input.businessId, from: business.status, status: input.next, version: input.expectedVersion + 1 };
  },
  audit: (input, v) => ({
    businessId: v.businessId,
    entity: "RtBusiness",
    entityId: v.businessId,
    changes: { from: v.from, to: v.status, reason: input.reason },
  }),
});

export const overrideFeature = definePlatformAction({
  name: "platform.feature.override",
  input: z.object({
    businessId: z.string().min(1).max(64),
    feature: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_.-]*$/i),
    enabled: z.boolean(),
    reason: reasonSchema,
  }),
  writes: true,
  async run({ adminId, tx, input }) {
    const business = await tx.rtBusiness.findUnique({ where: { id: input.businessId }, select: { id: true } });
    if (!business) throw new NotFoundError();
    const row = await tx.rtFeatureOverride.create({
      data: {
        businessId: business.id,
        feature: input.feature,
        enabled: input.enabled,
        reason: input.reason,
        grantedById: adminId,
      },
      select: { id: true },
    });
    return { overrideId: row.id, businessId: business.id };
  },
  audit: (input, v) => ({
    businessId: v.businessId,
    entity: "RtFeatureOverride",
    entityId: v.overrideId,
    changes: { feature: input.feature, enabled: input.enabled, reason: input.reason },
  }),
});
