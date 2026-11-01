import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptInvitation } from "@/server/admin/invitations";
import { setBusinessStatus } from "@/server/admin/lifecycle";
import { provisionBusiness } from "@/server/admin/provision";
import { grantSupport, revokeSupport } from "@/server/admin/support";
import { MemoryMailer, setMailer } from "@/server/email/mailer";
import { resolveActor } from "@/server/framework/actor";
import { gateOf } from "@/server/framework/gate";
import { scopedDb } from "@/server/framework/scoped-db";
import { completeSetupStep, getSetupProgress } from "@/server/setup/progress";
import { shellOptions } from "@/server/shell/options";
import { useTestDb } from "../helpers/db";
import { createPlan, createPlatformAdmin, createUser } from "../helpers/fixtures";

/*
 * R0 acceptance: the whole path through the real actions. Only rows that no action creates are
 * inserted directly: the plan, the platform admin, and the Better Auth user accounts (sign-up).
 */

const { db } = useTestDb();

beforeEach(() => setMailer(new MemoryMailer()));
afterEach(() => setMailer(undefined));

const key = () => randomUUID();

describe("R0 acceptance", () => {
  it("a super admin creates a business with two branches and invites an owner, the owner accepts, adds a cashier for branch A, and the cashier cannot read branch B, another business, or any write while the subscription is READ_ONLY", async () => {
    await createPlan(db, { maxBranches: 5 });
    const admin = await createPlatformAdmin(db);
    const asAdmin = () => ({ userId: admin.id, idempotencyKey: key() });

    // 1. The super admin provisions a business with two branches; the owner invitation goes out with it.
    const provisioned = await provisionBusiness(
      {
        name: "سوق الأمل",
        activityType: "MARKET",
        capabilities: [],
        branches: [{ name: "فرع A" }, { name: "فرع B" }],
        ownerEmail: "owner@amal.test",
        currencies: ["IQD", "USD"],
        planCode: "basic",
        trialDays: 30,
      },
      asAdmin(),
    );
    expect(provisioned.ok).toBe(true);
    if (!provisioned.ok) return;
    const businessId = provisioned.value.businessId;
    const branchA = await db.rtBranch.findFirstOrThrow({ where: { businessId, name: "فرع A" } });
    const branchB = await db.rtBranch.findFirstOrThrow({ where: { businessId, name: "فرع B" } });

    // A second business (another tenant) the cashier must never see.
    const other = await provisionBusiness(
      {
        name: "متجر آخر",
        activityType: "CLOTHING",
        capabilities: [],
        branches: [{ name: "الرئيسي" }],
        ownerEmail: "owner@other.test",
        currencies: ["IQD"],
        planCode: "basic",
        trialDays: 30,
      },
      asAdmin(),
    );
    expect(other.ok).toBe(true);
    if (!other.ok) return;

    // 2. The owner signs up with the invited email and accepts.
    const owner = await createUser(db, { email: "owner@amal.test" });
    const accepted = await acceptInvitation({ token: provisioned.value.token! }, { userId: owner.id, idempotencyKey: key() });
    expect(accepted).toMatchObject({ ok: true, value: { businessId, activated: true } });
    const asOwner = () => ({ userId: owner.id, businessId, idempotencyKey: key() });
    expect(await gateOf(businessId, db)).toBe("FULL");

    // 3. The owner adds a cashier for branch A through the setup wizard (step 5).
    const cashier = await createUser(db, { email: "cashier@amal.test" });
    const added = await completeSetupStep(
      { step: 5, data: { staff: [{ email: "cashier@amal.test", role: "CASHIER", branchIds: [branchA.id] }] } },
      asOwner(),
    );
    expect(added).toEqual({ ok: true, value: null });
    const progress = await getSetupProgress({}, asOwner());
    expect(progress.ok && progress.value.find((s) => s.step === 5)?.status).toBe("DONE");
    const asCashier = (businessIdOverride = businessId) => ({ userId: cashier.id, businessId: businessIdOverride, idempotencyKey: key() });

    // 4a. The cashier sees branch A only, and cannot read branch B's rows.
    const options = await shellOptions({}, asCashier());
    expect(options.ok).toBe(true);
    if (!options.ok) return;
    expect(options.value.role).toBe("CASHIER");
    expect(options.value.branches.map((b) => b.id)).toEqual([branchA.id]);

    const actor = await resolveActor(cashier.id, businessId);
    expect(actor.branchIds).toEqual([branchA.id]);
    const scoped = scopedDb(actor);
    expect(await scoped.rtBranch.findUnique({ where: { id: branchB.id } })).toBeNull();
    expect(await scoped.rtLocation.findMany({ where: { branchId: branchB.id } })).toEqual([]);
    expect((await scoped.rtLocation.findMany()).every((l) => l.branchId === branchA.id)).toBe(true);
    expect(await scoped.rtLocation.count()).toBe(1);

    // 4b. The cashier cannot read another business.
    expect(await shellOptions({}, asCashier(other.value.businessId))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await scoped.rtBusiness.findUnique({ where: { id: other.value.businessId } })).toBeNull();
    expect(await scoped.rtBranch.count({ where: { businessId: other.value.businessId } })).toBe(0);
    // ... nor the setup wizard of their own business (no staff.manage permission).
    expect(await getSetupProgress({}, asCashier())).toMatchObject({ ok: false, code: "FORBIDDEN" });

    // A support grant made while FULL: revoking it is the one write allowed while READ_ONLY (below).
    const granted = await grantSupport({ granteeId: admin.id, scopes: ["STOCK_READ"], reason: "مراجعة أرصدة الفرع", hours: 2 }, asOwner());
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;

    const extra = await createUser(db, { email: "extra@amal.test" });
    const counts = async () => ({
      audit: await db.rtAuditLog.count({ where: { businessId } }),
      staff: await db.rtStaff.count({ where: { businessId } }),
      branches: await db.rtBranch.count({ where: { businessId } }),
      capabilities: await db.rtCapability.count({ where: { businessId, enabled: true } }),
      grants: await db.rtSupportGrant.count({ where: { businessId } }),
      progressDone: await db.rtSetupProgress.count({ where: { businessId, status: "DONE" } }),
      business: await db.rtBusiness.findUniqueOrThrow({ where: { id: businessId }, select: { name: true, activityType: true } }),
    });

    /** Every business write the owner has is refused with READ_ONLY; the cashier's is FORBIDDEN; nothing changes. */
    async function everyWriteRefused() {
      expect(await gateOf(businessId, db)).toBe("READ_ONLY");
      const before = await counts();
      const version = (await db.rtBusiness.findUniqueOrThrow({ where: { id: businessId } })).version;
      const writes = [
        () => completeSetupStep({ step: 1, data: { name: "x", defaultCurrency: "IQD", enabledCurrencies: ["IQD"], timezone: "Asia/Baghdad", expectedVersion: version } }, asOwner()),
        () => completeSetupStep({ step: 2, data: { branches: [{ name: "فرع C" }] } }, asOwner()),
        () => completeSetupStep({ step: 3, data: { activityType: "MIXED", capabilities: ["VARIANTS"], expectedVersion: version } }, asOwner()),
        () => completeSetupStep({ step: 5, data: { staff: [{ email: extra.email, role: "CASHIER", branchIds: [branchA.id] }] } }, asOwner()),
        () => grantSupport({ granteeId: admin.id, scopes: ["STOCK_READ"], reason: "مراجعة أرصدة الفرع", hours: 2 }, asOwner()),
      ];
      for (const write of writes) expect(await write()).toMatchObject({ ok: false, code: "READ_ONLY" });
      // The cashier's attempt on branch B: no write permission at all, refused before the gate is consulted.
      expect(
        await completeSetupStep({ step: 2, data: { branches: [{ id: branchB.id, name: "فرع D", expectedVersion: branchB.version }] } }, asCashier()),
      ).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(await counts()).toEqual(before);
      // Reads still work while READ_ONLY, and still only branch A for the cashier.
      const readOnlyOptions = await shellOptions({}, asCashier());
      expect(readOnlyOptions.ok && readOnlyOptions.value.branches.map((b) => b.id)).toEqual([branchA.id]);
    }

    // 4c. READ_ONLY through the subscription: the live (TRIAL) subscription ended and its grace
    // period passed (dates set as a fixture; the real gate derives the mode from them).
    const subscription = await db.rtSubscription.findFirstOrThrow({ where: { businessId, status: "TRIAL" } });
    const DAY = 86_400_000;
    const lapsed = new Date(Date.now() - 30 * DAY);
    await db.rtSubscription.update({
      where: { id: subscription.id },
      data: { currentPeriodStart: new Date(Date.now() - 60 * DAY), trialEndsAt: lapsed, currentPeriodEnd: lapsed, graceDays: 7 },
    });
    await everyWriteRefused();

    // The deliberate exception: revoking support access (spec allowWhenReadOnly) still works while
    // READ_ONLY, because taking access away must never wait on billing.
    expect(await revokeSupport({ grantId: granted.value.grantId }, asOwner())).toMatchObject({ ok: true });
    expect((await db.rtSupportGrant.findUniqueOrThrow({ where: { id: granted.value.grantId } })).revokedAt).toBeInstanceOf(Date);

    // Back to FULL (subscription restored), then 4d. READ_ONLY through the real lifecycle action (suspension).
    await db.rtSubscription.update({
      where: { id: subscription.id },
      data: { currentPeriodStart: subscription.currentPeriodStart, trialEndsAt: subscription.trialEndsAt, currentPeriodEnd: subscription.currentPeriodEnd },
    });
    expect(await gateOf(businessId, db)).toBe("FULL");
    const biz = await db.rtBusiness.findUniqueOrThrow({ where: { id: businessId } });
    const suspended = await setBusinessStatus(
      { businessId, next: "SUSPENDED", reason: "متأخر عن دفع الاشتراك الشهري", expectedVersion: biz.version },
      asAdmin(),
    );
    expect(suspended).toMatchObject({ ok: true });
    await everyWriteRefused();
  });
});
