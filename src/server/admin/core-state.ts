import { applyCoreState, type CoreState } from "@/server/core/state";
import { db } from "@/server/db";

/*
 * Studio state sync, platform-level like the rest of this folder (no tenant scope: the caller is
 * the signed core, not a business user). Base client on purpose, as in core-provision.ts.
 */

/**
 * Applies a snapshot to an already linked business. `null` = no business has this coreBusinessId
 * (the caller answers a retryable 404; nothing is created here). `version` is the stored version
 * after the call, so a stale or equal snapshot reports the version that won.
 */
export async function syncCoreState(state: CoreState): Promise<{ applied: boolean; version: number } | null> {
  return db.$transaction(async (tx) => {
    const business = await tx.rtBusiness.findUnique({ where: { coreBusinessId: state.coreBusinessId }, select: { id: true } });
    if (!business) return null;
    const { applied } = await applyCoreState(tx, business.id, state);
    const after = await tx.rtBusiness.findUniqueOrThrow({ where: { id: business.id }, select: { coreStateVersion: true } });
    return { applied, version: after.coreStateVersion ?? 0 };
  });
}

export type CoreStateReport = {
  version: number;
  status: "SETUP" | "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  aiUsageMonth: { month: string; units: number };
};

/**
 * What Studio reconciles against. `aiUsageMonth.units` is RtAiUsage.halfUnits, the same unit the
 * quota counts in (src/server/intake/quota.ts): one receipt read is 2, one barcode fallback read
 * is 1, so units are HALF units, not receipts. `month` is the current UTC calendar month; the
 * quota itself buckets by the business's time zone, so within a few hours of a month boundary
 * the two can differ (display only, per the spec).
 */
export async function readCoreState(coreBusinessId: string, now: Date = new Date()): Promise<CoreStateReport | null> {
  const business = await db.rtBusiness.findUnique({
    where: { coreBusinessId },
    select: { id: true, status: true, coreStateVersion: true },
  });
  if (!business) return null;
  const month = now.toISOString().slice(0, 7);
  const usage = await db.rtAiUsage.findUnique({ where: { businessId_month: { businessId: business.id, month } }, select: { halfUnits: true } });
  return { version: business.coreStateVersion ?? 0, status: business.status, aiUsageMonth: { month, units: usage?.halfUnits ?? 0 } };
}
