import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { provisionBusiness } from "@/server/admin/provision";
import { MemoryMailer, setMailer } from "@/server/email/mailer";
import { dumpAllRows, useTestDb } from "../helpers/db";
import { createPlan, createPlatformAdmin, createUser } from "../helpers/fixtures";

const { db } = useTestDb();

let mailer: MemoryMailer;
beforeEach(() => {
  mailer = new MemoryMailer();
  setMailer(mailer);
});
afterEach(() => {
  setMailer(undefined);
  vi.restoreAllMocks();
});

const ARABIC = /[؀-ۿ]/;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function input(overrides: Record<string, unknown> = {}) {
  return {
    name: "سوق الرافدين",
    activityType: "MARKET",
    capabilities: ["CREDIT"],
    branches: [{ name: "المنصور" }, { name: "الكرادة" }],
    ownerEmail: "Owner@Example.TEST",
    currencies: ["IQD", "USD"],
    planCode: "basic",
    trialDays: 14,
    ...overrides,
  };
}

async function admin() {
  const user = await createPlatformAdmin(db);
  return (key: string) => ({ userId: user.id, idempotencyKey: key });
}

/** Row counts of every table provisioning writes to. */
async function counts() {
  return {
    business: await db.rtBusiness.count(),
    branch: await db.rtBranch.count(),
    location: await db.rtLocation.count(),
    subscription: await db.rtSubscription.count(),
    subscriptionEvent: await db.rtSubscriptionEvent.count(),
    capability: await db.rtCapability.count(),
    invitation: await db.rtInvitation.count(),
    audit: await db.rtAuditLog.count(),
    idem: await db.rtIdempotency.count(),
  };
}
const NOTHING = {
  business: 0,
  branch: 0,
  location: 0,
  subscription: 0,
  subscriptionEvent: 0,
  capability: 0,
  invitation: 0,
  audit: 0,
  idem: 0,
};

describe("provisionBusiness", () => {
  it("provisionBusiness writes business, branches, default locations, trial subscription, invitation and audit together or not at all", async () => {
    await createPlan(db);
    const meta = await admin();

    // A failure mid-way (the mail goes out after every row is written) leaves nothing behind.
    setMailer({ send: () => Promise.reject(new Error("smtp down")) });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(provisionBusiness(input(), meta("k1"))).rejects.toThrow(ARABIC);
    expect(logged).toHaveBeenCalled();
    expect(await counts()).toEqual(NOTHING);

    // The same key works afterwards (the failed attempt did not consume it) and writes everything.
    setMailer(mailer);
    const before = Date.now();
    const r = await provisionBusiness(input(), meta("k1"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { businessId, invitationId, token } = r.value;

    const business = await db.rtBusiness.findUniqueOrThrow({ where: { id: businessId } });
    expect(business).toMatchObject({
      name: "سوق الرافدين",
      activityType: "MARKET",
      status: "SETUP",
      timezone: "Asia/Baghdad",
      enabledCurrencies: ["IQD", "USD"],
      defaultCurrency: "IQD",
    });

    const branches = await db.rtBranch.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } });
    expect(branches.map((b) => b.name).sort()).toEqual(["الكرادة", "المنصور"]);
    const locations = await db.rtLocation.findMany({ where: { businessId } });
    expect(locations).toHaveLength(2);
    for (const b of branches) {
      const own = locations.filter((l) => l.branchId === b.id);
      expect(own).toHaveLength(1);
      expect(own[0]).toMatchObject({ name: "المخزن الرئيسي", sellable: true });
    }

    const sub = await db.rtSubscription.findFirstOrThrow({ where: { businessId } });
    expect(sub).toMatchObject({ status: "TRIAL", planCode: "basic" });
    const days = (sub.trialEndsAt!.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(13.99);
    expect(days).toBeLessThan(14.01);

    const caps = await db.rtCapability.findMany({ where: { businessId } });
    expect(caps.map((c) => c.capability).sort()).toEqual(["BATCH", "CREDIT", "HOLDS", "MULTI_UNIT", "WEIGHT"]);
    expect(caps.every((c) => c.enabled)).toBe(true);

    const inv = await db.rtInvitation.findUniqueOrThrow({ where: { id: invitationId } });
    expect(inv).toMatchObject({ businessId, email: "owner@example.test", usedAt: null, supersededAt: null });
    const ttl = (inv.expiresAt.getTime() - before) / 86_400_000;
    expect(ttl).toBeGreaterThan(6.99);
    expect(ttl).toBeLessThan(7.01);

    const audit = await db.rtAuditLog.findMany();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      businessId,
      actorId: meta("x").userId,
      action: "platform.business.provision",
      entity: "RtBusiness",
      entityId: businessId,
    });

    // Token: returned once, mailed with the APP_URL link, stored only as its hash.
    expect(typeof token).toBe("string");
    expect(token!.length).toBeGreaterThanOrEqual(43);
    expect(inv.tokenHash).toBe(sha256(token!));
    expect(inv.tokenHash).not.toBe(token);
    expect(mailer.messages).toHaveLength(1);
    expect(mailer.messages[0]!.to).toBe("owner@example.test");
    expect(mailer.messages[0]!.text).toContain(`http://localhost:3000/invite#token=${token}`);
    expect(mailer.messages[0]!.subject).toMatch(ARABIC);
    expect(await dumpAllRows(db)).not.toContain(token!);
  });

  it("the same idempotencyKey creates one business", async () => {
    await createPlan(db);
    const meta = await admin();
    const first = await provisionBusiness(input(), meta("same"));
    const second = await provisionBusiness(input(), meta("same"));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.businessId).toBe(first.value.businessId);
    expect(second.value.invitationId).toBe(first.value.invitationId);
    // The raw token is returned once: the replay does not carry it.
    expect(second.value.token).toBeNull();
    expect(await db.rtBusiness.count()).toBe(1);
    expect(await db.rtInvitation.count()).toBe(1);
    expect(mailer.messages).toHaveLength(1);

    // Concurrent double submit with a fresh key: still exactly one more business.
    const race = await Promise.all([provisionBusiness(input(), meta("race")), provisionBusiness(input(), meta("race"))]);
    expect(race.every((r) => r.ok)).toBe(true);
    expect(await db.rtBusiness.count()).toBe(2);
  });

  it("zero branches or 21 branches are refused", async () => {
    await createPlan(db, { maxBranches: 50 });
    const meta = await admin();
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `فرع ${i + 1}` }));
    expect(await provisionBusiness(input({ branches: [] }), meta("a"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await provisionBusiness(input({ branches: many }), meta("b"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await counts()).toEqual(NOTHING);
    // 20 is the maximum and works.
    expect(await provisionBusiness(input({ branches: many.slice(0, 20) }), meta("c"))).toMatchObject({ ok: true });
    expect(await db.rtBranch.count()).toBe(20);
    expect(await db.rtLocation.count()).toBe(20);
  });

  it("refuses more branches than the plan allows", async () => {
    await createPlan(db, { maxBranches: 1 });
    const meta = await admin();
    const r = await provisionBusiness(input(), meta("k"));
    expect(r).toMatchObject({ ok: false, code: "PLAN_LIMIT" });
    expect((r as { message: string }).message).toMatch(ARABIC);
    expect(await counts()).toEqual(NOTHING);
    expect(mailer.messages).toHaveLength(0);
  });

  it("an unknown or inactive plan is refused", async () => {
    await createPlan(db, { code: "old", active: false });
    const meta = await admin();
    expect(await provisionBusiness(input({ planCode: "nope" }), meta("a"))).toMatchObject({
      ok: false,
      code: "PLAN_UNAVAILABLE",
    });
    expect(await provisionBusiness(input({ planCode: "old" }), meta("b"))).toMatchObject({
      ok: false,
      code: "PLAN_UNAVAILABLE",
    });
    expect(await counts()).toEqual(NOTHING);
  });

  it("SERIAL and BATCH together are refused at provisioning (requested or through the defaults)", async () => {
    await createPlan(db);
    const meta = await admin();
    expect(await provisionBusiness(input({ capabilities: ["SERIAL"] }), meta("a"))).toMatchObject({
      ok: false,
      code: "CAPABILITY_CONFLICT",
    });
    expect(
      await provisionBusiness(input({ activityType: "ELECTRONICS", capabilities: ["BATCH"] }), meta("b")),
    ).toMatchObject({ ok: false, code: "CAPABILITY_CONFLICT" });
    expect(await counts()).toEqual(NOTHING);
    // Duplicates and defaults collapse to one row each.
    const ok = await provisionBusiness(input({ activityType: "ELECTRONICS", capabilities: ["SERIAL", "SERIAL"] }), meta("c"));
    expect(ok.ok).toBe(true);
    expect((await db.rtCapability.findMany()).map((c) => c.capability).sort()).toEqual(["SERIAL", "WARRANTY"]);
  });

  it("validates currencies, email and trial days", async () => {
    await createPlan(db);
    const meta = await admin();
    const bad = [
      { currencies: [] },
      { currencies: ["EUR"] },
      { currencies: ["IQD", "IQD"] },
      { ownerEmail: "not-an-email" },
      { trialDays: 0 },
      { trialDays: 1.5 },
      { activityType: "BAKERY" },
      { capabilities: ["TELEPORT"] },
      { name: "   " },
      { branches: [{ name: "" }] },
    ];
    for (const b of bad) {
      expect(await provisionBusiness(input(b), meta(JSON.stringify(b))), JSON.stringify(b)).toMatchObject({
        ok: false,
        code: "INVALID_INPUT",
      });
    }
    expect(await counts()).toEqual(NOTHING);
    // USD first: USD is the default currency.
    const r = await provisionBusiness(input({ currencies: ["USD", "IQD"] }), meta("usd"));
    expect(r.ok).toBe(true);
    expect(await db.rtBusiness.findFirstOrThrow()).toMatchObject({ defaultCurrency: "USD" });
  });

  it("a user who is not a platform admin is FORBIDDEN with no side effects", async () => {
    await createPlan(db);
    const user = await createUser(db);
    const r = await provisionBusiness(input(), { userId: user.id, idempotencyKey: "k" });
    expect(r).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect((r as { message: string }).message).toMatch(ARABIC);
    expect(await provisionBusiness(input(), { userId: "", idempotencyKey: "k" })).toMatchObject({ code: "FORBIDDEN" });
    expect(await counts()).toEqual(NOTHING);
    expect(mailer.messages).toHaveLength(0);
  });

  it("a write without an idempotency key is INVALID_INPUT", async () => {
    await createPlan(db);
    const meta = await admin();
    expect(await provisionBusiness(input(), meta(""))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await counts()).toEqual(NOTHING);
  });
});
