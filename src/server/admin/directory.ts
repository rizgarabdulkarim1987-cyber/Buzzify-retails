import { z } from "zod";
import type { RtActivityType, RtBusinessStatus, SubscriptionStatus } from "@/generated/prisma/client";
import { AI_INTAKE_FEATURE, OVERRIDE_LATEST_FIRST } from "@/server/framework/features";
import { definePlatformAction } from "@/server/framework/platform-action";

/*
 * The platform admin's list of businesses and the active plans the create form offers. Only
 * platform-level facts (name, lifecycle status, activity type, creation date, subscription
 * status, the ai.intake switch): no tenant operational data.
 */

export const DIRECTORY_LIMIT = 200;

export type DirectoryBusiness = {
  id: string;
  name: string;
  status: RtBusinessStatus;
  activityType: RtActivityType;
  createdAt: Date;
  /** The latest subscription's status, or null when the business has none. */
  subscriptionStatus: SubscriptionStatus | null;
  /** The ai.intake master switch: the latest override (as featureEnabled reads it), false when none. */
  aiIntake: boolean;
  /** Linked to Studio (coreBusinessId set): Studio is the source of truth for plan, subscription, status and the AI switch. */
  coreLinked: boolean;
};

export type DirectoryPlan = { code: string; name: string; maxBranches: number };

export const listBusinesses = definePlatformAction({
  name: "platform.business.list",
  input: z.object({}),
  writes: false,
  async run({ tx }): Promise<{ businesses: DirectoryBusiness[]; plans: DirectoryPlan[] }> {
    const rows = await tx.rtBusiness.findMany({
      select: {
        id: true,
        name: true,
        status: true,
        activityType: true,
        createdAt: true,
        coreBusinessId: true,
        subscriptions: { select: { status: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 },
        featureOverrides: {
          where: { feature: AI_INTAKE_FEATURE },
          select: { enabled: true },
          orderBy: [...OVERRIDE_LATEST_FIRST],
          take: 1,
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: DIRECTORY_LIMIT,
    });
    const plans = await tx.rtPlan.findMany({
      where: { active: true, NOT: { code: { startsWith: "core:" } } },
      select: { code: true, name: true, maxBranches: true },
      orderBy: [{ maxBranches: "asc" }, { code: "asc" }],
    });
    return {
      businesses: rows.map(({ subscriptions, featureOverrides, coreBusinessId, ...b }) => ({
        ...b,
        coreLinked: coreBusinessId !== null,
        subscriptionStatus: subscriptions[0]?.status ?? null,
        aiIntake: featureOverrides[0]?.enabled === true,
      })),
      plans,
    };
  },
});
