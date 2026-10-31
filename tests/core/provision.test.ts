import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/core/v1/provision/route";
import { signRequest } from "@/server/core/signing";
import { applyCoreState, coreStateSchema } from "@/server/core/state";
import { useTestDb } from "../helpers/db";
import { createPlan } from "../helpers/fixtures";

const { db } = useTestDb();

const PATH = "/api/core/v1/provision";
const SECRET = "sync-secret-current";
const ENV = ["CORE_SYNC_SECRET", "CORE_SYNC_SECRET_PREVIOUS"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CORE_SYNC_SECRET = SECRET;
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function state(over: Record<string, unknown> = {}, planOver: Record<string, unknown> = {}) {
  return {
    coreBusinessId: "core-biz-1",
    version: 1,
    status: "ACTIVE",
    plan: { code: "retail-pro", name: "Retail Pro", maxBranches: 3, maxTerminals: 4, maxUsers: 9, storageMb: 2048, aiMonthly: 50, ...planOver },
    subscription: {
      status: "ACTIVE",
      trialEndsAt: null,
      currentPeriodStart: "2026-11-01T00:00:00.000Z",
      currentPeriodEnd: "2026-12-01T00:00:00.000Z",
      graceDays: 5,
    },
    aiIntake: true,
    owner: { coreUserId: "core-user-1", email: "owner@example.test", emailVerified: true, name: "Owner" },
    ...over,
  };
}

function body(over: Record<string, unknown> = {}, stateOver: Record<string, unknown> = {}, planOver: Record<string, unknown> = {}) {
  return {
    coreBusinessId: "core-biz-1",
    name: "سوق الرافدين",
    activityType: "MARKET",
    capabilities: ["CREDIT"],
    branches: [{ name: "المنصور" }, { name: "الكرادة" }],
    currencies: ["IQD", "USD"],
    state: state(stateOver, planOver),
    ...over,
  };
}

function signed(b: unknown, secret = SECRET, raw?: string) {
  const text = raw ?? JSON.stringify(b);
  return new Request(`http://localhost${PATH}`, {
    method: "POST",
    body: text,
    headers: { "content-type": "application/json", ...signRequest("POST", PATH, text, secret) },
  });
}

async function counts() {
  return {
    business: await db.rtBusiness.count(),
    branch: await db.rtBranch.count(),
    location: await db.rtLocation.count(),
    subscription: await db.rtSubscription.count(),
    capability: await db.rtCapability.count(),
    invitation: await db.rtInvitation.count(),
    plan: await db.rtPlan.count(),
    audit: await db.rtAuditLog.count(),
    override: await db.rtFeatureOverride.count(),
  };
}
const NOTHING = { business: 0, branch: 0, location: 0, subscription: 0, capability: 0, invitation: 0, plan: 0, audit: 0, override: 0 };

describe("POST /api/core/v1/provision", () => {
  it("creates the business with branches, locations, capabilities, applies the first snapshot, answers {businessId}", async () => {
    const res = await POST(signed(body()));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { businessId: string };
    expect(Object.keys(json)).toEqual(["businessId"]);

    const biz = await db.rtBusiness.findUniqueOrThrow({ where: { id: json.businessId } });
    expect(biz.coreBusinessId).toBe("core-biz-1");
    expect(biz.coreOwnerUserId).toBe("core-user-1");
    expect(biz.coreStateVersion).toBe(1);
    expect(biz.status).toBe("ACTIVE"); // SETUP, then the snapshot's ACTIVE
    expect(biz.name).toBe("سوق الرافدين");

    expect(await db.rtBranch.count({ where: { businessId: json.businessId } })).toBe(2);
    expect(await db.rtLocation.count({ where: { businessId: json.businessId, sellable: true } })).toBe(2);
    const caps = (await db.rtCapability.findMany({ where: { businessId: json.businessId } })).map((c) => c.capability);
    expect(caps).toContain("CREDIT");

    const plan = await db.rtPlan.findUniqueOrThrow({ where: { code: "core:core-biz-1:retail-pro" } });
    expect(plan).toMatchObject({ maxBranches: 3, maxTerminals: 4, maxUsers: 9, storageMb: 2048, aiMonthly: 50, name: "Retail Pro" });
    const subs = await db.rtSubscription.findMany({ where: { businessId: json.businessId } });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ status: "ACTIVE", planCode: "core:core-biz-1:retail-pro", graceDays: 5, trialEndsAt: null });
    expect(subs[0]!.currentPeriodEnd.toISOString()).toBe("2026-12-01T00:00:00.000Z");

    const overrides = await db.rtFeatureOverride.findMany({ where: { businessId: json.businessId } });
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({ feature: "ai.intake", enabled: true, reason: "synced from Studio v1", grantedById: "core-sync" });
  });

  it("creates no owner invitation", async () => {
    expect((await POST(signed(body()))).status).toBe(200);
    expect(await db.rtInvitation.count()).toBe(0);
  });

  it("the same request twice yields one business and the same id", async () => {
    const a = (await (await POST(signed(body()))).json()) as { businessId: string };
    const res = await POST(signed(body()));
    expect(res.status).toBe(200);
    const b = (await res.json()) as { businessId: string };
    expect(b.businessId).toBe(a.businessId);
    const c = await counts();
    expect(c.business).toBe(1);
    expect(c.branch).toBe(2);
    expect(c.subscription).toBe(1);
    expect(c.override).toBe(1);
  });

  it("a wrong signature, a missing signature and a tampered body are 401 and write nothing", async () => {
    expect((await POST(signed(body(), "some-other-secret-0123456789"))).status).toBe(401);
    const noHeaders = new Request(`http://localhost${PATH}`, { method: "POST", body: JSON.stringify(body()) });
    expect((await POST(noHeaders)).status).toBe(401);
    const good = signed(body());
    const tampered = new Request(`http://localhost${PATH}`, { method: "POST", body: JSON.stringify(body({ name: "x" })), headers: good.headers });
    expect((await POST(tampered)).status).toBe(401);
    expect(await counts()).toEqual(NOTHING);
    expect(await db.rtLoginAttempt.count()).toBe(0);
  });

  it("more branches than the plan allows is 422 and writes nothing (plan row included)", async () => {
    const res = await POST(signed(body({}, {}, { maxBranches: 1 })));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("PLAN_LIMIT");
    expect(await counts()).toEqual(NOTHING);
  });

  it("an invalid body is 400 and a state for another business is 400", async () => {
    expect((await POST(signed(null, SECRET, "{not json"))).status).toBe(400);
    expect((await POST(signed(body({ branches: [] })))).status).toBe(400);
    expect((await POST(signed(body({}, { coreBusinessId: "other" })))).status).toBe(400);
    expect(await counts()).toEqual(NOTHING);
  });

  it("a local plan with the same code is left untouched; the core plan is a separate core: row", async () => {
    await createPlan(db, { code: "retail-pro", maxBranches: 1 });
    expect((await POST(signed(body()))).status).toBe(200);
    expect(await db.rtPlan.count()).toBe(2);
    expect((await db.rtPlan.findUniqueOrThrow({ where: { code: "retail-pro" } })).maxBranches).toBe(1);
    expect((await db.rtPlan.findUniqueOrThrow({ where: { code: "core:core-biz-1:retail-pro" } })).maxBranches).toBe(3);
  });

  it("a deactivated core plan is re-activated and does not block provisioning", async () => {
    await db.rtPlan.create({ data: { code: "core:core-biz-1:retail-pro", name: "old", maxBranches: 1, maxTerminals: 1, maxUsers: 1, storageMb: 1, aiMonthly: 0, active: false } });
    expect((await POST(signed(body()))).status).toBe(200);
    expect((await db.rtPlan.findUniqueOrThrow({ where: { code: "core:core-biz-1:retail-pro" } })).active).toBe(true);
  });

  it("rejects a TRIAL snapshot without trialEndsAt and a period that ends before it starts (400, nothing written)", async () => {
    const sub = state().subscription;
    expect((await POST(signed(body({}, { subscription: { ...sub, status: "TRIAL", trialEndsAt: null } })))).status).toBe(400);
    expect((await POST(signed(body({}, { subscription: { ...sub, currentPeriodEnd: sub.currentPeriodStart } })))).status).toBe(400);
    expect((await POST(signed(body({}, { subscription: { ...sub, currentPeriodEnd: "2026-10-01T00:00:00.000Z" } })))).status).toBe(400);
    expect(await counts()).toEqual(NOTHING);
    expect(coreStateSchema.safeParse(state({ subscription: { ...sub, status: "TRIAL", trialEndsAt: "2026-11-10T00:00:00.000Z" } })).success).toBe(true);
  });
});

describe("applyCoreState", () => {
  async function provisioned() {
    const res = await POST(signed(body()));
    return ((await res.json()) as { businessId: string }).businessId;
  }
  const apply = async (businessId: string, over: Record<string, unknown>) => {
    const parsed = coreStateSchema.parse(state(over));
    return db.$transaction((tx) => applyCoreState(tx, businessId, parsed));
  };

  it("ignores an older or equal version, and a late v5 after v6 leaves v6", async () => {
    const id = await provisioned();
    expect(await apply(id, { version: 6, status: "SUSPENDED" })).toEqual({ applied: true });
    expect(await apply(id, { version: 5, status: "ACTIVE" })).toEqual({ applied: false });
    expect(await apply(id, { version: 6, status: "ACTIVE" })).toEqual({ applied: false });
    const biz = await db.rtBusiness.findUniqueOrThrow({ where: { id } });
    expect(biz).toMatchObject({ status: "SUSPENDED", coreStateVersion: 6 });
  });

  it("ARCHIVED is terminal: a later ACTIVE snapshot is recorded but not applied", async () => {
    const id = await provisioned();
    await apply(id, { version: 2, status: "ARCHIVED" });
    const events = await db.rtSubscriptionEvent.count({ where: { businessId: id } });
    await apply(id, { version: 3, status: "ACTIVE", aiIntake: false });
    expect(await db.rtBusiness.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "ARCHIVED", coreStateVersion: 3 });
    expect(await db.rtSubscriptionEvent.count({ where: { businessId: id } })).toBe(events);
    expect(await apply(id, { version: 3, status: "ACTIVE" })).toEqual({ applied: false });
  });

  it("appends an ai.intake override only when the value changes", async () => {
    const id = await provisioned(); // v1: on (1 row)
    await apply(id, { version: 2, aiIntake: true });
    expect(await db.rtFeatureOverride.count({ where: { businessId: id } })).toBe(1);
    await apply(id, { version: 3, aiIntake: false });
    const rows = await db.rtFeatureOverride.findMany({ where: { businessId: id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.enabled, r.reason])).toEqual([[true, "synced from Studio v1"], [false, "synced from Studio v3"]]);
  });

  it("updates the subscription in place and keeps a single live row", async () => {
    const id = await provisioned();
    await apply(id, { version: 2, subscription: { ...state().subscription, status: "GRACE", graceDays: 9 } });
    const subs = await db.rtSubscription.findMany({ where: { businessId: id } });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ status: "GRACE", graceDays: 9 });
    await apply(id, { version: 3, subscription: { ...state().subscription, status: "EXPIRED" } });
    expect((await db.rtSubscription.findMany({ where: { businessId: id } }))[0]!.status).toBe("EXPIRED");
    await apply(id, { version: 4 });
    const after = await db.rtSubscription.findMany({ where: { businessId: id } });
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("ACTIVE");
  });
});
