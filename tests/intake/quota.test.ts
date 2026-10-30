import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAction } from "@/server/framework/action";
import { planAiMonthly } from "@/server/framework/business-info";
import { AI_INTAKE_FEATURE } from "@/server/framework/features";
import { aiMonth, getAiStatus, refundUnits, reserveUnits } from "@/server/intake/quota";
import { CONSENT_VERSION } from "@/server/intake/consent";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan, createPlatformAdmin } from "../helpers/fixtures";
import type { RtRole } from "@/generated/prisma/client";

const { db } = useTestDb();

const DAY = 86_400_000;
let keys = 0;
const key = () => `k${++keys}`;

/** A business on an ACTIVE subscription of its own plan with `aiMonthly` reads, and one staff member per role. */
async function shop(opts: { aiMonthly?: number; timezone?: string; subscribed?: boolean; ai?: boolean } = {}) {
  const roles: RtRole[] = ["OWNER", "MANAGER", "CASHIER", "STOCK", "PURCHASING", "ACCOUNTANT"];
  const w = await createBusinessWithStaff(db, { branches: ["Main"], staff: roles.map((r) => ({ key: r, role: r })) });
  const businessId = w.business.id;
  await db.rtBusiness.update({
    where: { id: businessId },
    data: { status: "ACTIVE", timezone: opts.timezone ?? "Asia/Baghdad" },
  });
  const code = `plan-${businessId}`;
  const plan = await createPlan(db, { code });
  await db.rtPlan.update({ where: { id: plan.id }, data: { aiMonthly: opts.aiMonthly ?? 100 } });
  if (opts.subscribed !== false) {
    await db.rtSubscription.create({
      data: {
        businessId,
        planCode: code,
        status: "ACTIVE",
        currentPeriodStart: new Date(Date.now() - DAY),
        currentPeriodEnd: new Date(Date.now() + 30 * DAY),
      },
    });
  }
  if (opts.ai !== false) {
    const admin = await createPlatformAdmin(db);
    await db.rtFeatureOverride.create({
      data: { businessId, feature: AI_INTAKE_FEATURE, enabled: true, reason: "تفعيل للاختبار من الدعم", grantedById: admin.id },
    });
  }
  const user = (role: RtRole) => w.staff[role]!.user.id;
  return { businessId, user };
}

/** Task 5/6 call reserveUnits/refundUnits inside their own actions; these wrappers do the same. */
const reserve = defineAction({
  name: "test.reserve",
  permission: null,
  input: z.object({ halfUnits: z.union([z.literal(1), z.literal(2)]), now: z.string().optional() }),
  writes: true,
  run: ({ actor, tx, input }) =>
    reserveUnits(tx, { businessId: actor.businessId, halfUnits: input.halfUnits, now: input.now ? new Date(input.now) : undefined }),
});
const refund = defineAction({
  name: "test.refund",
  permission: null,
  input: z.object({ month: z.string(), halfUnits: z.union([z.literal(1), z.literal(2)]) }),
  writes: true,
  async run({ actor, tx, input }) {
    await refundUnits(tx, { businessId: actor.businessId, month: input.month, halfUnits: input.halfUnits });
    return null;
  },
});

const reserveAs = (s: { businessId: string; user: (r: RtRole) => string }, halfUnits: 1 | 2, now?: Date) =>
  reserve({ halfUnits, now: now?.toISOString() }, { userId: s.user("OWNER"), businessId: s.businessId, idempotencyKey: key() });
const refundAs = (s: { businessId: string; user: (r: RtRole) => string }, month: string, halfUnits: 1 | 2) =>
  refund({ month, halfUnits }, { userId: s.user("OWNER"), businessId: s.businessId, idempotencyKey: key() });
const usage = async (businessId: string) =>
  (await db.rtAiUsage.findMany({ where: { businessId }, orderBy: { month: "asc" }, select: { month: true, halfUnits: true } }));

describe("aiMonth", () => {
  it("is the calendar month in the business time zone, not UTC", () => {
    // 23:30 in Baghdad (UTC+3) on the last day of October: still October there and in UTC.
    expect(aiMonth(new Date("2026-10-31T20:30:00Z"), "Asia/Baghdad")).toBe("2026-10");
    // 00:30 on 1 November in Baghdad, while UTC is still 31 October 21:30.
    expect(aiMonth(new Date("2026-10-31T21:30:00Z"), "Asia/Baghdad")).toBe("2026-11");
    expect(aiMonth(new Date("2026-10-31T21:30:00Z"), "UTC")).toBe("2026-10");
  });
});

describe("reserveUnits", () => {
  it("counts a receipt as 2 half units and a barcode as 1, and refuses past the limit without a partial take", async () => {
    const s = await shop({ aiMonthly: 2 }); // limit 4 half units
    const a = await reserveAs(s, 2);
    expect(a).toEqual({ ok: true, value: { month: aiMonth(new Date(), "Asia/Baghdad"), remaining: 2 } });
    expect(await reserveAs(s, 1)).toMatchObject({ ok: true, value: { remaining: 1 } });
    expect(await reserveAs(s, 2)).toMatchObject({ ok: false, code: "AI_QUOTA_EXCEEDED" });
    expect(await reserveAs(s, 1)).toMatchObject({ ok: true, value: { remaining: 0 } });
    expect(await reserveAs(s, 1)).toMatchObject({ ok: false, code: "AI_QUOTA_EXCEEDED" });
    expect(await usage(s.businessId)).toEqual([{ month: aiMonth(new Date(), "Asia/Baghdad"), halfUnits: 4 }]);
  });

  it("never exceeds the limit under 20 concurrent reservations", async () => {
    const s = await shop({ aiMonthly: 3 }); // limit 6 half units
    const results = await Promise.all(Array.from({ length: 20 }, () => reserveAs(s, 1)));
    expect(results.filter((r) => r.ok)).toHaveLength(6);
    expect(results.filter((r) => !r.ok && r.code === "AI_QUOTA_EXCEEDED")).toHaveLength(14);
    expect((await usage(s.businessId))[0]!.halfUnits).toBe(6);
  });

  it("aiMonthly = 0 means the feature is closed, and no row is written", async () => {
    const s = await shop({ aiMonthly: 0 });
    expect(await reserveAs(s, 1)).toMatchObject({ ok: false, code: "AI_QUOTA_EXCEEDED" });
    expect(await usage(s.businessId)).toEqual([]);
  });

  it("no live subscription means no quota", async () => {
    const s = await shop({ subscribed: false });
    // Gate is CLOSED without a subscription, so the action itself is refused before the quota runs.
    expect((await reserveAs(s, 1)).ok).toBe(false);
    expect(await usage(s.businessId)).toEqual([]);
    expect(await planAiMonthly(s.businessId)).toBe(0);
    // An expired subscription's plan grants nothing either.
    const sub = await db.rtSubscription.create({
      data: { businessId: s.businessId, planCode: `plan-${s.businessId}`, status: "EXPIRED", currentPeriodStart: new Date(Date.now() - 60 * DAY), currentPeriodEnd: new Date(Date.now() - 30 * DAY) },
    });
    expect(await planAiMonthly(s.businessId)).toBe(0);
    await db.rtSubscription.update({ where: { id: sub.id }, data: { status: "ACTIVE" } });
    expect(await planAiMonthly(s.businessId)).toBe(100);
  });

  it("counts per month in the business time zone: 23:30 Baghdad on the last day vs 00:30 the next", async () => {
    const s = await shop({ aiMonthly: 1 }); // limit 2 half units
    const lateOctober = new Date("2026-10-31T20:30:00Z"); // 23:30 Baghdad, 31 October
    const earlyNovember = new Date("2026-10-31T21:30:00Z"); // 00:30 Baghdad, 1 November (UTC still October)
    expect(await reserveAs(s, 2, lateOctober)).toMatchObject({ ok: true, value: { month: "2026-10", remaining: 0 } });
    expect(await reserveAs(s, 1, lateOctober)).toMatchObject({ ok: false, code: "AI_QUOTA_EXCEEDED" });
    expect(await reserveAs(s, 2, earlyNovember)).toMatchObject({ ok: true, value: { month: "2026-11", remaining: 0 } });
    expect(await usage(s.businessId)).toEqual([
      { month: "2026-10", halfUnits: 2 },
      { month: "2026-11", halfUnits: 2 },
    ]);
  });

  it("another business is unaffected", async () => {
    const a = await shop({ aiMonthly: 1 });
    const b = await shop({ aiMonthly: 1 });
    expect((await reserveAs(a, 2)).ok).toBe(true);
    expect(await reserveAs(a, 1)).toMatchObject({ ok: false, code: "AI_QUOTA_EXCEEDED" });
    expect(await reserveAs(b, 2)).toMatchObject({ ok: true, value: { remaining: 0 } });
  });
});

describe("refundUnits", () => {
  it("gives back the reserved units of that month only, and never goes below 0", async () => {
    const s = await shop({ aiMonthly: 1 });
    const oct = new Date("2026-10-15T10:00:00Z");
    const nov = new Date("2026-11-15T10:00:00Z");
    expect((await reserveAs(s, 2, oct)).ok).toBe(true);
    expect((await reserveAs(s, 1, nov)).ok).toBe(true);
    expect((await refundAs(s, "2026-10", 2)).ok).toBe(true);
    expect(await usage(s.businessId)).toEqual([
      { month: "2026-10", halfUnits: 0 },
      { month: "2026-11", halfUnits: 1 },
    ]);
    // A second refund of the same reservation floors at 0 (Task 5 keeps the once-only rule on RtIntake).
    expect((await refundAs(s, "2026-10", 2)).ok).toBe(true);
    expect((await refundAs(s, "2026-11", 2)).ok).toBe(true);
    expect(await usage(s.businessId)).toEqual([
      { month: "2026-10", halfUnits: 0 },
      { month: "2026-11", halfUnits: 0 },
    ]);
  });

  it("a refund for a month with no row does nothing", async () => {
    const s = await shop();
    expect((await refundAs(s, "2026-01", 1)).ok).toBe(true);
    expect(await usage(s.businessId)).toEqual([]);
  });

  it("after a refund the units can be reserved again", async () => {
    const s = await shop({ aiMonthly: 1 });
    const r = await reserveAs(s, 2);
    if (!r.ok) throw new Error("reserve failed");
    expect(await reserveAs(s, 1)).toMatchObject({ ok: false, code: "AI_QUOTA_EXCEEDED" });
    expect((await refundAs(s, r.value.month, 2)).ok).toBe(true);
    expect(await reserveAs(s, 2)).toMatchObject({ ok: true, value: { remaining: 0 } });
  });
});

describe("getAiStatus", () => {
  const statusAs = (s: { businessId: string; user: (r: RtRole) => string }, role: RtRole = "OWNER") =>
    getAiStatus({}, { userId: s.user(role), businessId: s.businessId, idempotencyKey: "" });

  it("works while the master switch is closed and reports enabled: false; no data reads as zeros", async () => {
    const s = await shop({ ai: false, aiMonthly: 10 });
    expect(await statusAs(s)).toEqual({
      ok: true,
      value: {
        enabled: false,
        consent: false,
        consentCurrent: false,
        monthlyLimit: 10,
        limitHalfUnits: 20,
        usedHalfUnits: 0,
        warn: false,
      },
    });
  });

  it("reports this month's usage, consent, and the 80% warning", async () => {
    const s = await shop({ aiMonthly: 10 }); // 20 half units
    const month = aiMonth(new Date(), "Asia/Baghdad");
    await db.rtAiUsage.create({ data: { businessId: s.businessId, month, halfUnits: 15 } });
    await db.rtAiUsage.create({ data: { businessId: s.businessId, month: "2000-01", halfUnits: 20 } });
    expect(await statusAs(s)).toMatchObject({ ok: true, value: { enabled: true, usedHalfUnits: 15, limitHalfUnits: 20, warn: false } });
    await db.rtAiUsage.updateMany({ where: { businessId: s.businessId, month }, data: { halfUnits: 16 } });
    expect(await statusAs(s)).toMatchObject({ ok: true, value: { usedHalfUnits: 16, warn: true } });

    await db.rtBusiness.update({ where: { id: s.businessId }, data: { aiConsentAt: new Date(), aiConsentVersion: CONSENT_VERSION } });
    expect(await statusAs(s)).toMatchObject({ ok: true, value: { consent: true, consentCurrent: true } });
    await db.rtBusiness.update({ where: { id: s.businessId }, data: { aiConsentVersion: CONSENT_VERSION - 1 } });
    expect(await statusAs(s)).toMatchObject({ ok: true, value: { consent: true, consentCurrent: false } });
  });

  it("aiMonthly = 0 never warns", async () => {
    const s = await shop({ aiMonthly: 0 });
    expect(await statusAs(s)).toMatchObject({ ok: true, value: { monthlyLimit: 0, limitHalfUnits: 0, warn: false } });
  });

  it("is open to ai.use or catalog.manage holders only", async () => {
    const s = await shop();
    for (const role of ["OWNER", "MANAGER", "STOCK", "PURCHASING"] as const) {
      expect((await statusAs(s, role)).ok, role).toBe(true);
    }
    for (const role of ["CASHIER", "ACCOUNTANT"] as const) {
      expect(await statusAs(s, role), role).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
  });

  it("another business's usage is not counted", async () => {
    const a = await shop({ aiMonthly: 10 });
    const b = await shop({ aiMonthly: 10 });
    await db.rtAiUsage.create({ data: { businessId: a.businessId, month: aiMonth(new Date(), "Asia/Baghdad"), halfUnits: 18 } });
    expect(await statusAs(b)).toMatchObject({ ok: true, value: { usedHalfUnits: 0, warn: false } });
  });
});
