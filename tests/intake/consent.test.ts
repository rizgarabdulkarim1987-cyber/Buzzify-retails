import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { RtRole } from "@/generated/prisma/client";
import { defineAction } from "@/server/framework/action";
import { AI_INTAKE_FEATURE } from "@/server/framework/features";
import { CONSENT_VERSION, assertConsent, grantAiConsent, revokeAiConsent } from "@/server/intake/consent";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan, createPlatformAdmin } from "../helpers/fixtures";

const { db } = useTestDb();

const DAY = 86_400_000;
let keys = 0;
const key = () => `c${++keys}`;

/** A business on an ACTIVE subscription with an owner and a manager; the AI switch on unless `ai: false`. */
async function shop(opts: { ai?: boolean } = {}) {
  const w = await createBusinessWithStaff(db, {
    branches: ["Main"],
    staff: [
      { key: "OWNER", role: "OWNER" },
      { key: "MANAGER", role: "MANAGER" },
    ],
  });
  const businessId = w.business.id;
  await db.rtBusiness.update({ where: { id: businessId }, data: { status: "ACTIVE" } });
  const code = `plan-${businessId}`;
  await createPlan(db, { code });
  await db.rtSubscription.create({
    data: {
      businessId,
      planCode: code,
      status: "ACTIVE",
      currentPeriodStart: new Date(Date.now() - DAY),
      currentPeriodEnd: new Date(Date.now() + 30 * DAY),
    },
  });
  const admin = await createPlatformAdmin(db);
  const setSwitch = (enabled: boolean) =>
    db.rtFeatureOverride.create({ data: { businessId, feature: AI_INTAKE_FEATURE, enabled, reason: "تفعيل للاختبار من الدعم", grantedById: admin.id } });
  if (opts.ai !== false) await setSwitch(true);
  const user = (role: RtRole) => w.staff[role]!.user.id;
  return { businessId, user, setSwitch };
}

type Shop = Awaited<ReturnType<typeof shop>>;
const grant = (s: Shop, role: RtRole = "OWNER") => grantAiConsent({}, { userId: s.user(role), businessId: s.businessId, idempotencyKey: key() });
const revoke = (s: Shop, role: RtRole = "OWNER") => revokeAiConsent({}, { userId: s.user(role), businessId: s.businessId, idempotencyKey: key() });
const business = (id: string) =>
  db.rtBusiness.findUniqueOrThrow({ where: { id }, select: { aiConsentAt: true, aiConsentVersion: true, version: true } });

/** Task 5/6 call assertConsent inside their own actions; this wrapper does the same. */
const checkConsent = defineAction({
  name: "test.checkConsent",
  permission: null,
  input: z.object({}),
  writes: false,
  async run({ actor, tx }) {
    await assertConsent(tx, actor.businessId);
    return "ok";
  },
});
const check = (s: Shop) => checkConsent({}, { userId: s.user("MANAGER"), businessId: s.businessId, idempotencyKey: "" });

describe("AI consent", () => {
  it("the consent text version is 1", () => {
    expect(CONSENT_VERSION).toBe(1);
  });

  it("without consent assertConsent refuses with AI_CONSENT_REQUIRED", async () => {
    const s = await shop();
    expect(await check(s)).toMatchObject({ ok: false, code: "AI_CONSENT_REQUIRED" });
  });

  it("the owner grants it: stamped with the current version, audited, business version bumped", async () => {
    const s = await shop();
    const before = await business(s.businessId);
    const r = await grant(s);
    expect(r).toMatchObject({ ok: true, value: { consentVersion: CONSENT_VERSION } });
    const after = await business(s.businessId);
    expect(after.aiConsentAt).toBeInstanceOf(Date);
    expect(after.aiConsentVersion).toBe(CONSENT_VERSION);
    expect(after.version).toBe(before.version + 1);
    expect(await check(s)).toEqual({ ok: true, value: "ok" });

    const audit = await db.rtAuditLog.findMany({ where: { businessId: s.businessId, action: "ai.consent.grant" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: s.user("OWNER"), entity: "RtBusiness", entityId: s.businessId });
    expect(audit[0]!.changes).toMatchObject({ aiConsentVersion: CONSENT_VERSION });
  });

  it("a consent to an older text version no longer counts", async () => {
    const s = await shop();
    expect((await grant(s)).ok).toBe(true);
    await db.rtBusiness.update({ where: { id: s.businessId }, data: { aiConsentVersion: CONSENT_VERSION - 1 } });
    expect(await check(s)).toMatchObject({ ok: false, code: "AI_CONSENT_REQUIRED" });
    // Granting again brings it to the current text.
    expect((await grant(s)).ok).toBe(true);
    expect(await check(s)).toEqual({ ok: true, value: "ok" });
  });

  it("a manager can neither grant nor revoke", async () => {
    const s = await shop();
    expect(await grant(s, "MANAGER")).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect((await business(s.businessId)).aiConsentAt).toBeNull();
    expect((await grant(s)).ok).toBe(true);
    expect(await revoke(s, "MANAGER")).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect((await business(s.businessId)).aiConsentVersion).toBe(CONSENT_VERSION);
  });

  it("both are refused while the master switch is closed", async () => {
    const s = await shop({ ai: false });
    expect(await grant(s)).toMatchObject({ ok: false, code: "AI_DISABLED" });
    expect((await business(s.businessId)).aiConsentAt).toBeNull();
    await s.setSwitch(true);
    expect((await grant(s)).ok).toBe(true);
    await s.setSwitch(false);
    expect(await revoke(s)).toMatchObject({ ok: false, code: "AI_DISABLED" });
    expect((await business(s.businessId)).aiConsentVersion).toBe(CONSENT_VERSION);
  });

  it("a READ_ONLY business cannot grant", async () => {
    const s = await shop();
    await db.rtBusiness.update({ where: { id: s.businessId }, data: { status: "SUSPENDED" } });
    expect(await grant(s)).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect((await business(s.businessId)).aiConsentAt).toBeNull();
  });

  it("revoking clears both columns, is audited, and deletes nothing", async () => {
    const s = await shop();
    expect((await grant(s)).ok).toBe(true);
    await db.rtAiUsage.create({ data: { businessId: s.businessId, month: "2026-10", halfUnits: 3 } });
    expect(await revoke(s)).toMatchObject({ ok: true, value: { consentVersion: null } });
    expect(await business(s.businessId)).toMatchObject({ aiConsentAt: null, aiConsentVersion: null });
    expect(await check(s)).toMatchObject({ ok: false, code: "AI_CONSENT_REQUIRED" });
    expect(await db.rtAiUsage.findMany({ where: { businessId: s.businessId }, select: { halfUnits: true } })).toEqual([{ halfUnits: 3 }]);
    const audit = await db.rtAuditLog.findMany({ where: { businessId: s.businessId, action: "ai.consent.revoke" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entity: "RtBusiness", entityId: s.businessId });
  });

  it("another business is unaffected", async () => {
    const a = await shop();
    const b = await shop();
    expect((await grant(a)).ok).toBe(true);
    expect(await check(b)).toMatchObject({ ok: false, code: "AI_CONSENT_REQUIRED" });
    expect((await business(b.businessId)).aiConsentAt).toBeNull();
  });
});
