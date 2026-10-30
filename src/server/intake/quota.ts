import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { can } from "@/server/domain/permissions";
import { businessToday } from "@/server/domain/stock";
import { defineAction } from "@/server/framework/action";
import { planAiMonthly } from "@/server/framework/business-info";
import { ForbiddenError, RuleError } from "@/server/framework/errors";
import { AI_INTAKE_FEATURE, featureEnabled } from "@/server/framework/features";
import { CONSENT_VERSION } from "./consent";

type Tx = Prisma.TransactionClient;

/*
 * The monthly AI quota (spec 3.10, 3ب.4). Counted in half units: one receipt read (all its pages,
 * however many model calls) is 2, one AI barcode fallback read is 1. The limit is the plan's
 * aiMonthly x 2; aiMonthly = 0, or no live subscription, means the feature is closed. One RtAiUsage
 * row per business and month, the month being the calendar month in the business's time zone.
 *
 * reserveUnits / refundUnits are plain functions for the intake actions (Tasks 5 and 6) to call
 * inside their own defineAction transactions, which also check the ai.intake switch, permissions
 * and consent. Carry-forward rules for those callers:
 * - Reserve before calling the provider, in the short transaction that opens the RtIntake.
 * - The AI_UNAVAILABLE and AI_BAD_OUTPUT messages promise "not counted against your quota", so those
 *   paths MUST refund. An unreadable receipt (a valid answer with nothing in it) is not refunded.
 * - refundUnits is a plain safe decrement, not idempotent by itself: the caller refunds at most once
 *   per intake (Task 5 keeps that on RtIntake.refundedAt, set in the same transaction as the refund),
 *   so re-uploading never yields free reads.
 */

/** "YYYY-MM": the calendar month of `now` in `timeZone` (IANA name). */
export function aiMonth(now: Date, timeZone: string): string {
  return businessToday(now, timeZone).toISOString().slice(0, 7);
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

async function monthOf(tx: Tx, businessId: string, now: Date): Promise<string> {
  const b = await tx.rtBusiness.findFirst({ where: { id: businessId }, select: { timezone: true } });
  if (!b) throw new Error("quota: business not found in scope");
  return aiMonth(now, b.timezone);
}

/**
 * Takes `halfUnits` from this month's quota, or refuses with AI_QUOTA_EXCEEDED (nothing is taken
 * then, not even part of it). Returns the month charged (pass it to refundUnits) and the half units
 * left. Safe under concurrency without an advisory lock: the row is created with
 * createMany+skipDuplicates (a racing insert waits and then does nothing), and the charge is one
 * guarded UPDATE (halfUnits <= limit - n) whose row lock queues concurrent callers; under READ
 * COMMITTED Postgres re-checks the guard on the committed row, so the total never exceeds the limit.
 * `now` is injectable for tests.
 */
export async function reserveUnits(
  tx: Tx,
  { businessId, halfUnits, now = new Date() }: { businessId: string; halfUnits: 1 | 2; now?: Date },
): Promise<{ month: string; remaining: number }> {
  if (halfUnits !== 1 && halfUnits !== 2) throw new Error("reserveUnits: halfUnits must be 1 or 2");
  const limit = (await planAiMonthly(businessId)) * 2;
  if (limit <= 0) throw new RuleError("AI_QUOTA_EXCEEDED");
  const month = await monthOf(tx, businessId, now);

  await tx.rtAiUsage.createMany({ data: [{ businessId, month }], skipDuplicates: true });
  const { count } = await tx.rtAiUsage.updateMany({
    where: { businessId, month, halfUnits: { lte: limit - halfUnits } },
    data: { halfUnits: { increment: halfUnits } },
  });
  if (count === 0) throw new RuleError("AI_QUOTA_EXCEEDED");
  const row = await tx.rtAiUsage.findFirst({ where: { businessId, month }, select: { halfUnits: true } });
  return { month, remaining: Math.max(0, limit - (row?.halfUnits ?? limit)) };
}

/**
 * Gives `halfUnits` back to `month` (the month reserveUnits returned, even if the calendar has moved
 * on), never below 0. No row: nothing to do. Not idempotent: see the note at the top of this file.
 */
export async function refundUnits(tx: Tx, { businessId, month, halfUnits }: { businessId: string; month: string; halfUnits: number }): Promise<void> {
  if (!MONTH.test(month)) throw new Error("refundUnits: month must be YYYY-MM");
  if (!Number.isInteger(halfUnits) || halfUnits <= 0) throw new Error("refundUnits: halfUnits must be a positive integer");
  const { count } = await tx.rtAiUsage.updateMany({
    where: { businessId, month, halfUnits: { gte: halfUnits } },
    data: { halfUnits: { decrement: halfUnits } },
  });
  if (count === 0) {
    await tx.rtAiUsage.updateMany({ where: { businessId, month, halfUnits: { lt: halfUnits } }, data: { halfUnits: 0 } });
  }
}

export type AiStatus = {
  /** The ai.intake master switch (spec 9). */
  enabled: boolean;
  /** The owner consented at some point. */
  consent: boolean;
  /** When the owner last gave consent (null without one). */
  consentAt: Date | null;
  /** ...and to the current consent text (CONSENT_VERSION); only this lets a read run. */
  consentCurrent: boolean;
  /** Receipt reads per month in the plan (full units). */
  monthlyLimit: number;
  limitHalfUnits: number;
  /** Half units used this month (a barcode read makes it odd, hence half units, not full ones). */
  usedHalfUnits: number;
  /** Used is at least 80% of a non-zero limit. */
  warn: boolean;
};

/**
 * The AI settings and this month's usage, for the consent page and the read screens. Open to holders
 * of `ai.use` or `catalog.manage` (defineAction takes one permission, so the second is checked here).
 * Deliberately NOT behind the master switch: it is how the UI learns the switch is off.
 */
export const getAiStatus = defineAction({
  name: "ai.status",
  permission: null,
  input: z.object({}).strict(),
  writes: false,
  async run({ actor, tx }): Promise<AiStatus> {
    if (!can(actor.role, "ai.use") && !can(actor.role, "catalog.manage")) throw new ForbiddenError("ai.use");
    const { businessId } = actor;
    const b = await tx.rtBusiness.findFirst({
      where: { id: businessId },
      select: { timezone: true, aiConsentAt: true, aiConsentVersion: true },
    });
    if (!b) throw new Error("getAiStatus: business not found in scope");
    const month = aiMonth(new Date(), b.timezone);
    const usage = await tx.rtAiUsage.findFirst({ where: { businessId, month }, select: { halfUnits: true } });
    const monthlyLimit = await planAiMonthly(businessId);
    const limitHalfUnits = monthlyLimit * 2;
    const usedHalfUnits = usage?.halfUnits ?? 0;
    const consent = b.aiConsentAt !== null;
    return {
      enabled: await featureEnabled(businessId, AI_INTAKE_FEATURE),
      consent,
      consentAt: b.aiConsentAt,
      consentCurrent: consent && b.aiConsentVersion === CONSENT_VERSION,
      monthlyLimit,
      limitHalfUnits,
      usedHalfUnits,
      warn: limitHalfUnits > 0 && usedHalfUnits * 5 >= limitHalfUnits * 4,
    };
  },
});
