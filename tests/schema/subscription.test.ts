import { describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff } from "../helpers/fixtures";

const { db } = useTestDb();

const at = (iso: string) => new Date(iso);

async function setup() {
  const { business } = await createBusinessWithStaff(db);
  await db.rtPlan.create({
    data: { code: "basic", name: "Basic", maxBranches: 1, maxTerminals: 2, maxUsers: 5, storageMb: 500, aiMonthly: 0 },
  });
  return business;
}

const sub = (
  businessId: string,
  status: Prisma.RtSubscriptionUncheckedCreateInput["status"],
): Prisma.RtSubscriptionUncheckedCreateInput => ({
  businessId,
  planCode: "basic",
  status,
  currentPeriodStart: at("2026-03-01T00:00:00+03:00"),
  currentPeriodEnd: at("2026-04-01T00:00:00+03:00"),
});

describe("subscription schema", () => {
  it("applies defaults: graceDays 7, version 1; plan limits are Int columns", async () => {
    const b = await setup();
    const s = await db.rtSubscription.create({ data: sub(b.id, "TRIAL") });
    expect(s).toMatchObject({ graceDays: 7, version: 1, trialEndsAt: null, cancelledAt: null });
    const p = await db.rtPlan.findUniqueOrThrow({ where: { code: "basic" } });
    expect(p).toMatchObject({ maxBranches: 1, maxTerminals: 2, maxUsers: 5, storageMb: 500, aiMonthly: 0, active: true, version: 1 });
  });

  it("a second live subscription (TRIAL, ACTIVE or GRACE) for the same business is rejected", async () => {
    const b = await setup();
    await db.rtSubscription.create({ data: sub(b.id, "ACTIVE") });
    for (const status of ["TRIAL", "ACTIVE", "GRACE"] as const) {
      await expect(db.rtSubscription.create({ data: sub(b.id, status) })).rejects.toMatchObject({ code: "P2002" });
    }
  });

  it("ended subscriptions are not limited, and another business may have its own live one", async () => {
    const b = await setup();
    const other = (await createBusinessWithStaff(db)).business;
    await db.rtSubscription.create({ data: sub(b.id, "EXPIRED") });
    await db.rtSubscription.create({ data: sub(b.id, "CANCELLED") });
    await db.rtSubscription.create({ data: sub(b.id, "ACTIVE") });
    await db.rtSubscription.create({ data: sub(other.id, "ACTIVE") });
    expect(await db.rtSubscription.count()).toBe(4);
  });

  it("a subscription must reference an existing plan", async () => {
    const b = await setup();
    await expect(db.rtSubscription.create({ data: { ...sub(b.id, "ACTIVE"), planCode: "ghost" } })).rejects.toMatchObject({
      code: "P2003",
    });
  });

  it("a feature override reason shorter than 10 characters is rejected by the database", async () => {
    const b = await setup();
    const row = { businessId: b.id, feature: "ai", enabled: true, grantedById: "admin" };
    await expect(db.rtFeatureOverride.create({ data: { ...row, reason: "too short" } })).rejects.toThrow(/check|constraint/i);
    const ok = await db.rtFeatureOverride.create({ data: { ...row, reason: "ten chars!" } });
    expect(ok.reason).toBe("ten chars!");
  });

  it("payment idempotencyKey is unique and amounts are BigInt minor units", async () => {
    const b = await setup();
    const s = await db.rtSubscription.create({ data: sub(b.id, "ACTIVE") });
    const pay = (idempotencyKey: string): Prisma.RtSubscriptionPaymentUncheckedCreateInput => ({
      businessId: b.id,
      subscriptionId: s.id,
      amountMinor: 50_000_000_000n,
      currency: "IQD",
      method: "ZAINCASH",
      reference: "ref-1",
      paidAt: at("2026-03-01T10:00:00+03:00"),
      coversFrom: at("2026-03-01T00:00:00+03:00"),
      coversTo: at("2026-04-01T00:00:00+03:00"),
      idempotencyKey,
      recordedById: "admin",
      note: "",
    });
    const first = await db.rtSubscriptionPayment.create({ data: pay("pay-1") });
    expect(first.amountMinor).toBe(50_000_000_000n);
    await expect(db.rtSubscriptionPayment.create({ data: pay("pay-1") })).rejects.toMatchObject({ code: "P2002" });
    await db.rtSubscriptionPayment.create({ data: pay("pay-2") });
  });

  it("events store metadata JSON and optional from-status and actor", async () => {
    const b = await setup();
    const s = await db.rtSubscription.create({ data: sub(b.id, "TRIAL") });
    const e = await db.rtSubscriptionEvent.create({
      data: { subscriptionId: s.id, businessId: b.id, type: "TRIAL_STARTED", toStatus: "TRIAL", data: { days: 14 } },
    });
    expect(e).toMatchObject({ fromStatus: null, actorId: null, data: { days: 14 } });
  });
});
