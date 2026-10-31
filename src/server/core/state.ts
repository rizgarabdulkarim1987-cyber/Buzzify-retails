import { z, type ZodType } from "zod";
import type { Prisma, RtBusinessStatus, SubscriptionStatus } from "@/generated/prisma/client";
import { AI_INTAKE_FEATURE, featureEnabled } from "@/server/framework/features";

/*
 * The state snapshot Studio (core) pushes for a linked business, and how Retails applies it.
 * Studio is the source of truth: a snapshot carries a version that only grows, Retails applies it
 * when it is newer than the stored one and ignores an older or equal one (so delivery order and
 * duplicates do not matter). It lands on the existing tables (RtBusiness, RtPlan, RtSubscription,
 * RtFeatureOverride) so the gate and the AI quota keep working unchanged.
 *
 * applyCoreState runs on a caller's transaction and holds a row lock on the business, so two
 * snapshots for one business are applied one after the other, never interleaved.
 */

export const CORE_SYNC_ACTOR = "core-sync";

const SUBSCRIPTION_STATUSES = ["TRIAL", "ACTIVE", "GRACE", "EXPIRED", "CANCELLED"] as const satisfies readonly SubscriptionStatus[];
const BUSINESS_STATUSES = ["ACTIVE", "SUSPENDED", "ARCHIVED"] as const satisfies readonly RtBusinessStatus[];
const LIVE_STATUSES: SubscriptionStatus[] = ["TRIAL", "ACTIVE", "GRACE"];

export type CoreState = {
  coreBusinessId: string;
  version: number;
  status: (typeof BUSINESS_STATUSES)[number];
  plan: { code: string; name: string; maxBranches: number; maxTerminals: number; maxUsers: number; storageMb: number; aiMonthly: number };
  subscription: {
    status: SubscriptionStatus;
    trialEndsAt: Date | null;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    graceDays: number;
  };
  aiIntake: boolean;
  owner: { coreUserId: string; email: string; emailVerified: boolean; name: string };
};

const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const limit = z.number().int().min(0).max(1_000_000_000);
const id = z.string().trim().min(1).max(128);

export const coreStateSchema: ZodType<CoreState> = z.object({
  coreBusinessId: id,
  version: z.number().int().min(1).max(2_000_000_000),
  status: z.enum(BUSINESS_STATUSES),
  plan: z.object({
    code: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(120),
    maxBranches: limit,
    maxTerminals: limit,
    maxUsers: limit,
    storageMb: limit,
    aiMonthly: limit,
  }),
  subscription: z.object({
    status: z.enum(SUBSCRIPTION_STATUSES),
    trialEndsAt: isoDate.nullable(),
    currentPeriodStart: isoDate,
    currentPeriodEnd: isoDate,
    graceDays: z.number().int().min(0).max(365),
  }),
  aiIntake: z.boolean(),
  owner: z.object({
    coreUserId: id,
    email: z.string().trim().max(254).pipe(z.email()),
    emailVerified: z.boolean(),
    name: z.string().trim().max(200),
  }),
});

/** Creates the plan or overwrites its name and limits with the snapshot's (Studio is the source). */
export async function upsertCorePlan(tx: Prisma.TransactionClient, plan: CoreState["plan"]): Promise<void> {
  const { code, ...fields } = plan;
  await tx.rtPlan.upsert({ where: { code }, create: { code, ...fields }, update: fields });
}

/**
 * Applies `state` to the business unless it is not newer than the stored version. One call is one
 * set of writes on `tx`; the caller's transaction makes it all-or-nothing.
 */
export async function applyCoreState(tx: Prisma.TransactionClient, businessId: string, state: CoreState): Promise<{ applied: boolean }> {
  // Row lock: concurrent snapshots for this business queue here and re-read the version after.
  const locked = await tx.$queryRaw<{ coreStateVersion: number | null }[]>`
    SELECT "coreStateVersion" FROM "RtBusiness" WHERE "id" = ${businessId} FOR UPDATE`;
  if (locked.length === 0) throw new Error("applyCoreState: unknown business");
  if (state.version <= (locked[0]!.coreStateVersion ?? 0)) return { applied: false };

  await upsertCorePlan(tx, state.plan);

  // SETUP becomes ACTIVE with the first ACTIVE snapshot; afterwards Studio's status is taken as is.
  await tx.rtBusiness.update({
    where: { id: businessId },
    data: { status: state.status, coreOwnerUserId: state.owner.coreUserId, coreStateVersion: state.version, version: { increment: 1 } },
  });

  const sub = state.subscription;
  const subData = {
    planCode: state.plan.code,
    status: sub.status,
    trialEndsAt: sub.trialEndsAt,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    graceDays: sub.graceDays,
    cancelledAt: sub.status === "CANCELLED" ? new Date() : null,
  };
  // The live subscription if there is one, else the newest; Retails keeps one row per linked business.
  const current =
    (await tx.rtSubscription.findFirst({ where: { businessId, status: { in: LIVE_STATUSES } }, orderBy: { createdAt: "desc" } })) ??
    (await tx.rtSubscription.findFirst({ where: { businessId }, orderBy: { createdAt: "desc" } }));
  if (!current) {
    const created = await tx.rtSubscription.create({ data: { businessId, ...subData }, select: { id: true } });
    await subscriptionEvent(tx, created.id, businessId, null, sub.status, state);
  } else {
    await tx.rtSubscription.update({
      where: { id: current.id },
      data: { ...subData, cancelledAt: sub.status === "CANCELLED" ? (current.cancelledAt ?? new Date()) : null, version: { increment: 1 } },
    });
    if (current.status !== sub.status) await subscriptionEvent(tx, current.id, businessId, current.status, sub.status, state);
  }

  // Append-only override, only when the effective value changes (no row means off).
  if ((await featureEnabled(businessId, AI_INTAKE_FEATURE, tx)) !== state.aiIntake) {
    await tx.rtFeatureOverride.create({
      data: {
        businessId,
        feature: AI_INTAKE_FEATURE,
        enabled: state.aiIntake,
        reason: `synced from Studio v${state.version}`,
        grantedById: CORE_SYNC_ACTOR,
      },
    });
  }
  return { applied: true };
}

function subscriptionEvent(
  tx: Prisma.TransactionClient,
  subscriptionId: string,
  businessId: string,
  from: SubscriptionStatus | null,
  to: SubscriptionStatus,
  state: CoreState,
) {
  return tx.rtSubscriptionEvent.create({
    data: {
      subscriptionId,
      businessId,
      type: "core.synced",
      fromStatus: from,
      toStatus: to,
      actorId: CORE_SYNC_ACTOR,
      data: { planCode: state.plan.code, version: state.version },
    },
  });
}
