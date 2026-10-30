import { db } from "@/server/db";
import { gateOf, type GateMode } from "./gate";
import { currentPlatformTx } from "./platform-tx";

/*
 * Platform facts about a business that tenant code may need but cannot read itself (the plan and
 * the subscription are platform-managed tables, unreachable through scopedDb). Read with the base
 * client, so they live in the framework folder. Callers must already have checked that the user is
 * a member of the business (e.g. a successful action of that business).
 */

/** The business's gate right now (FULL, READ_ONLY or CLOSED). */
export function currentGate(businessId: string): Promise<GateMode> {
  return gateOf(businessId, db);
}

/**
 * How many branches the business's plan allows (the live subscription's plan, else the most recent
 * one); 0 when there is no subscription at all. Inside an action it reads on the action's own
 * transaction (see platform-tx.ts).
 */
export async function planBranchLimit(businessId: string): Promise<number> {
  const client = currentPlatformTx(businessId) ?? db;
  const orderBy = [{ createdAt: "desc" as const }, { id: "desc" as const }];
  const select = { plan: { select: { maxBranches: true } } };
  const sub =
    (await client.rtSubscription.findFirst({ where: { businessId, status: { in: ["TRIAL", "ACTIVE", "GRACE"] } }, orderBy, select })) ??
    (await client.rtSubscription.findFirst({ where: { businessId }, orderBy, select }));
  return sub?.plan.maxBranches ?? 0;
}

/**
 * AI receipt reads per month in the plan of the business's live subscription (TRIAL, ACTIVE or
 * GRACE, newest first). 0 when there is no live subscription: the AI quota is then closed (unlike
 * planBranchLimit, an expired subscription's plan grants nothing here). Inside an action it reads on
 * the action's own transaction (see platform-tx.ts), so concurrent reservations cannot starve the pool.
 */
export async function planAiMonthly(businessId: string): Promise<number> {
  const client = currentPlatformTx(businessId) ?? db;
  const sub = await client.rtSubscription.findFirst({
    where: { businessId, status: { in: ["TRIAL", "ACTIVE", "GRACE"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { plan: { select: { aiMonthly: true } } },
  });
  return Math.max(0, sub?.plan.aiMonthly ?? 0);
}
