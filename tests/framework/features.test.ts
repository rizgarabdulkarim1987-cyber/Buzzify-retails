import { describe, expect, it } from "vitest";
import { z } from "zod";
import { overrideFeature } from "@/server/admin/lifecycle";
import { defineAction } from "@/server/framework/action";
import { RuleError } from "@/server/framework/errors";
import { AI_INTAKE_FEATURE, aiEnabledPrecondition, assertAiEnabled, featureEnabled } from "@/server/framework/features";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan, createPlatformAdmin } from "../helpers/fixtures";

const { db } = useTestDb();

const DAY = 86_400_000;
const REASON = "طلب المالك عبر الهاتف";
const ARABIC = /[؀-ۿ]/;

/** A business with an ACTIVE subscription (gate FULL) and an owner. */
async function shop() {
  const w = await createBusinessWithStaff(db, { branches: ["Main"], staff: [{ key: "owner", role: "OWNER" }] });
  await db.rtBusiness.update({ where: { id: w.business.id }, data: { status: "ACTIVE" } });
  await db.rtSubscription.create({
    data: {
      businessId: w.business.id,
      planCode: "basic",
      status: "ACTIVE",
      currentPeriodStart: new Date(Date.now() - DAY),
      currentPeriodEnd: new Date(Date.now() + 30 * DAY),
    },
  });
  return { businessId: w.business.id, ownerId: w.staff.owner!.user.id };
}

async function world() {
  await createPlan(db);
  const admin = await createPlatformAdmin(db);
  let n = 0;
  const set = (businessId: string, enabled: boolean) =>
    overrideFeature(
      { businessId, feature: AI_INTAKE_FEATURE, enabled, reason: REASON },
      { userId: admin.id, idempotencyKey: `o${++n}` },
    );
  return { a: await shop(), b: await shop(), set };
}

let runs = 0;
const aiAction = defineAction({
  name: "test.aiOnly",
  permission: null,
  input: z.object({}),
  writes: false,
  precondition: aiEnabledPrecondition,
  async run() {
    runs += 1;
    return "ran";
  },
});

describe("feature overrides", () => {
  it("the feature name is ai.intake", () => {
    expect(AI_INTAKE_FEATURE).toBe("ai.intake");
  });

  it("no row means off", async () => {
    const w = await world();
    expect(await featureEnabled(w.a.businessId, AI_INTAKE_FEATURE)).toBe(false);
    expect(await featureEnabled("no-such-business", AI_INTAKE_FEATURE)).toBe(false);
  });

  it("the latest override wins: on, then off, then on again", async () => {
    const w = await world();
    expect(await w.set(w.a.businessId, true)).toMatchObject({ ok: true });
    expect(await featureEnabled(w.a.businessId, AI_INTAKE_FEATURE)).toBe(true);
    expect(await w.set(w.a.businessId, false)).toMatchObject({ ok: true });
    expect(await featureEnabled(w.a.businessId, AI_INTAKE_FEATURE)).toBe(false);
    expect(await w.set(w.a.businessId, true)).toMatchObject({ ok: true });
    expect(await featureEnabled(w.a.businessId, AI_INTAKE_FEATURE)).toBe(true);
  });

  it("orders by createdAt, then id on a tie, whatever the insert order", async () => {
    const w = await world();
    const at = new Date("2026-10-01T10:00:00Z");
    const row = (id: string, enabled: boolean, createdAt: Date) => ({
      id,
      businessId: w.a.businessId,
      feature: AI_INTAKE_FEATURE,
      enabled,
      reason: REASON,
      grantedById: "admin",
      createdAt,
    });
    // A newer row inserted first, an older one after: the newer one decides.
    await db.rtFeatureOverride.create({ data: row("m", true, new Date(at.getTime() + 1000)) });
    await db.rtFeatureOverride.create({ data: row("z", false, at) });
    expect(await featureEnabled(w.a.businessId, AI_INTAKE_FEATURE)).toBe(true);
    // Same createdAt: the greater id decides.
    await db.rtFeatureOverride.create({ data: row("b", false, new Date(at.getTime() + 5000)) });
    await db.rtFeatureOverride.create({ data: row("a", true, new Date(at.getTime() + 5000)) });
    expect(await featureEnabled(w.a.businessId, AI_INTAKE_FEATURE)).toBe(false);
  });

  it("one shop's switch does not touch another shop, nor another feature", async () => {
    const w = await world();
    await w.set(w.a.businessId, true);
    expect(await featureEnabled(w.a.businessId, AI_INTAKE_FEATURE)).toBe(true);
    expect(await featureEnabled(w.b.businessId, AI_INTAKE_FEATURE)).toBe(false);
    expect(await featureEnabled(w.a.businessId, "ai.assistant")).toBe(false);
    await w.set(w.b.businessId, true);
    await w.set(w.a.businessId, false);
    expect(await featureEnabled(w.a.businessId, AI_INTAKE_FEATURE)).toBe(false);
    expect(await featureEnabled(w.b.businessId, AI_INTAKE_FEATURE)).toBe(true);
  });
});

describe("assertAiEnabled", () => {
  it("throws AI_DISABLED while the switch is off, passes once it is on", async () => {
    const w = await world();
    const err = await assertAiEnabled(w.a.businessId).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RuleError);
    expect((err as RuleError).code).toBe("AI_DISABLED");
    await w.set(w.a.businessId, true);
    await expect(assertAiEnabled(w.a.businessId)).resolves.toBeUndefined();
    await expect(assertAiEnabled(w.b.businessId)).rejects.toMatchObject({ code: "AI_DISABLED" });
  });

  it("as an action precondition: refused with an Arabic AI_DISABLED before run, allowed once on, refused again once off", async () => {
    const w = await world();
    runs = 0;
    const meta = { userId: w.a.ownerId, businessId: w.a.businessId, idempotencyKey: "" };
    const refused = await aiAction({}, meta);
    expect(refused).toMatchObject({ ok: false, code: "AI_DISABLED" });
    expect((refused as { message: string }).message).toMatch(ARABIC);
    expect(runs).toBe(0);

    await w.set(w.a.businessId, true);
    expect(await aiAction({}, meta)).toEqual({ ok: true, value: "ran" });
    expect(runs).toBe(1);

    await w.set(w.a.businessId, false);
    expect(await aiAction({}, meta)).toMatchObject({ ok: false, code: "AI_DISABLED" });
    expect(runs).toBe(1);
  });
});
