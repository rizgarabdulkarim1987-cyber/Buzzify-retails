import { describe, expect, it } from "vitest";
import { listBusinesses } from "@/server/admin/directory";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan, createPlatformAdmin, createUser } from "../helpers/fixtures";

const { db } = useTestDb();

describe("platform business directory", () => {
  it("is refused to anyone who is not a platform admin", async () => {
    const user = await createUser(db);
    expect(await listBusinesses({}, { userId: user.id, idempotencyKey: "" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("lists businesses newest first with their latest subscription status, and only active plans", async () => {
    const admin = await createPlatformAdmin(db);
    await createPlan(db, { code: "basic" });
    await createPlan(db, { code: "old", active: false });
    const first = await createBusinessWithStaff(db);
    const second = await createBusinessWithStaff(db);
    await db.rtBusiness.update({ where: { id: first.business.id }, data: { createdAt: new Date("2026-01-01T00:00:00Z") } });
    await db.rtSubscription.create({
      data: {
        businessId: second.business.id,
        planCode: "basic",
        status: "TRIAL",
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 86_400_000),
      },
    });

    const result = await listBusinesses({}, { userId: admin.id, idempotencyKey: "" });
    if (!result.ok) throw new Error(result.code);
    expect(result.value.businesses.map((b) => [b.id, b.subscriptionStatus])).toEqual([
      [second.business.id, "TRIAL"],
      [first.business.id, null],
    ]);
    expect(result.value.businesses[0]).toMatchObject({ name: "Test Business", status: "SETUP", activityType: "MARKET" });
    expect(result.value.plans.map((p) => p.code)).toEqual(["basic"]);
  });
});
