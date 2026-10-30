import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { db } from "@/server/db";
import type { Actor } from "./actor";
import { RuleError } from "./errors";
import { currentPlatformTx } from "./platform-tx";

type Client = PrismaClient | Prisma.TransactionClient;

/*
 * Per-business feature switches set by a platform admin (overrideFeature in src/server/admin/lifecycle.ts).
 * RtFeatureOverride is append-only and platform-managed (tenants never reach it), so it is read
 * here with the base client, like the subscription in gate.ts. The latest row decides; no row is off.
 */

/** The master switch of every R1b AI intake feature (receipt reading, AI barcode reading, consent, quota, screens). */
export const AI_INTAKE_FEATURE = "ai.intake";

/** Which override is in force: the newest by createdAt, then the greater id on a tie. */
export const OVERRIDE_LATEST_FIRST = [{ createdAt: "desc" }, { id: "desc" }] as const satisfies Prisma.RtFeatureOverrideOrderByWithRelationInput[];

/**
 * Whether `feature` is on for the business right now (no override row: off). Without a client it
 * reads on the running action's transaction when there is one (see platform-tx.ts), else on `db`.
 */
export async function featureEnabled(businessId: string, feature: string, client: Client = currentPlatformTx() ?? db): Promise<boolean> {
  const row = await client.rtFeatureOverride.findFirst({
    where: { businessId, feature },
    orderBy: [...OVERRIDE_LATEST_FIRST],
    select: { enabled: true },
  });
  return row?.enabled === true;
}

/** Refuses with AI_DISABLED unless the platform admin turned ai.intake on for this business. */
export async function assertAiEnabled(businessId: string, client: Client = db): Promise<void> {
  if (!(await featureEnabled(businessId, AI_INTAKE_FEATURE, client))) throw new RuleError("AI_DISABLED");
}

/**
 * For defineAction: `precondition: aiEnabledPrecondition`. Runs on every call, before the idempotent
 * replay lookup, so turning the switch off stops a replay of an earlier success too.
 */
export async function aiEnabledPrecondition({ actor }: { actor: Actor }): Promise<void> {
  await assertAiEnabled(actor.businessId);
}
