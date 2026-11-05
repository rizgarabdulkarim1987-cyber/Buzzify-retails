import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as healthGET } from "@/app/api/core/v1/health/route";
import { POST as provisionPOST } from "@/app/api/core/v1/provision/route";
import { GET, POST } from "@/app/api/core/v1/state/route";
import { readCoreState } from "@/server/admin/core-state";
import { aiMonth } from "@/server/intake/quota";
import { signRequest } from "@/server/core/signing";
import { featureEnabled } from "@/server/framework/features";
import { gateOf } from "@/server/framework/gate";
import { useTestDb } from "../helpers/db";
import { createUser } from "../helpers/fixtures";

const { db } = useTestDb();

const STATE = "/api/core/v1/state";
const PROVISION = "/api/core/v1/provision";
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

function state(over: Record<string, unknown> = {}) {
  return {
    coreBusinessId: "core-biz-1",
    version: 1,
    status: "ACTIVE",
    plan: { code: "retail-pro", name: "Retail Pro", maxBranches: 3, maxTerminals: 4, maxUsers: 9, storageMb: 2048, aiMonthly: 50 },
    subscription: {
      status: "ACTIVE",
      trialEndsAt: null,
      currentPeriodStart: "2026-11-01T00:00:00.000Z",
      currentPeriodEnd: "2099-12-01T00:00:00.000Z",
      graceDays: 5,
    },
    aiIntake: true,
    owner: { coreUserId: "core-user-1", email: "owner@example.test", emailVerified: true, name: "Owner" },
    ...over,
  };
}

function post(b: unknown, secret = SECRET, raw?: string) {
  const text = raw ?? JSON.stringify(b);
  return new Request(`http://localhost${STATE}`, {
    method: "POST",
    body: text,
    headers: { "content-type": "application/json", ...signRequest("POST", STATE, text, secret) },
  });
}

function get(query: string, secret = SECRET) {
  const path = `${STATE}${query}`;
  return new Request(`http://localhost${path}`, { method: "GET", headers: signRequest("GET", path, "", secret) });
}

async function provisioned(): Promise<string> {
  const text = JSON.stringify({
    coreBusinessId: "core-biz-1",
    name: "سوق",
    activityType: "MARKET",
    branches: [{ name: "A" }],
    currencies: ["IQD"],
    state: state(),
  });
  const res = await provisionPOST(
    new Request(`http://localhost${PROVISION}`, { method: "POST", body: text, headers: signRequest("POST", PROVISION, text, SECRET) }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { businessId: string }).businessId;
}

async function counts() {
  return {
    business: await db.rtBusiness.count(),
    plan: await db.rtPlan.count(),
    subscription: await db.rtSubscription.count(),
    override: await db.rtFeatureOverride.count(),
    audit: await db.rtAuditLog.count(),
    event: await db.rtSubscriptionEvent.count(),
  };
}

describe("POST /api/core/v1/state", () => {
  it("applies a newer snapshot: status, plan limits and subscription change", async () => {
    const id = await provisioned();
    const res = await POST(
      post(state({ version: 2, plan: { ...state().plan, maxBranches: 7, aiMonthly: 80 }, subscription: { ...state().subscription, status: "GRACE", graceDays: 9 } })),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true, version: 2 });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await db.rtBusiness.findUniqueOrThrow({ where: { id } })).toMatchObject({ coreStateVersion: 2 });
    expect(await db.rtPlan.findUniqueOrThrow({ where: { code: "core:core-biz-1:retail-pro" } })).toMatchObject({ maxBranches: 7, aiMonthly: 80 });
    expect(await db.rtSubscription.findFirstOrThrow({ where: { businessId: id } })).toMatchObject({ status: "GRACE", graceDays: 9 });
  });

  it("an older or equal version is 200 {applied:false, version:<stored>} and changes nothing", async () => {
    const id = await provisioned();
    await POST(post(state({ version: 4 })));
    const before = await counts();
    for (const v of [4, 3]) {
      const res = await POST(post(state({ version: v, status: "SUSPENDED", aiIntake: false })));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ applied: false, version: 4 });
    }
    expect(await counts()).toEqual(before);
    expect(await db.rtBusiness.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "ACTIVE", coreStateVersion: 4 });
  });

  it("reversed delivery, v6 then v5, ends at v6", async () => {
    const id = await provisioned();
    expect(await (await POST(post(state({ version: 6, status: "SUSPENDED" })))).json()).toEqual({ applied: true, version: 6 });
    expect(await (await POST(post(state({ version: 5, status: "ACTIVE" })))).json()).toEqual({ applied: false, version: 6 });
    expect(await db.rtBusiness.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "SUSPENDED", coreStateVersion: 6 });
  });

  it("an unknown coreBusinessId is a retryable 404 NOT_FOUND and creates nothing", async () => {
    const res = await POST(post(state({ coreBusinessId: "never-provisioned" })));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await counts()).toEqual({ business: 0, plan: 0, subscription: 0, override: 0, audit: 0, event: 0 });
  });

  it("SUSPENDED gives READ_ONLY and ARCHIVED gives CLOSED through gateOf", async () => {
    const id = await provisioned();
    expect(await gateOf(id, db)).toBe("FULL");
    await POST(post(state({ version: 2, status: "SUSPENDED" })));
    expect(await gateOf(id, db)).toBe("READ_ONLY");
    await POST(post(state({ version: 3, status: "ACTIVE" })));
    expect(await gateOf(id, db)).toBe("FULL");
    await POST(post(state({ version: 4, status: "ARCHIVED" })));
    expect(await gateOf(id, db)).toBe("CLOSED");
  });

  it("a newer snapshot for an ARCHIVED business is 200 {applied:false} with the newly recorded version", async () => {
    const id = await provisioned();
    await POST(post(state({ version: 2, status: "ARCHIVED" })));
    const res = await POST(post(state({ version: 5, status: "ACTIVE" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: false, version: 5 });
    expect(await db.rtBusiness.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "ARCHIVED", coreStateVersion: 5 });
  });

  it("ai.intake on then off flips featureEnabled", async () => {
    const id = await provisioned();
    expect(await featureEnabled(id, "ai.intake", db)).toBe(true);
    await POST(post(state({ version: 2, aiIntake: false })));
    expect(await featureEnabled(id, "ai.intake", db)).toBe(false);
    await POST(post(state({ version: 3, aiIntake: true })));
    expect(await featureEnabled(id, "ai.intake", db)).toBe(true);
  });

  it("a bad, missing or tampered signature is 401 and writes nothing, not even a rate-limit row", async () => {
    await provisioned();
    const before = await counts();
    const attempts = await db.rtLoginAttempt.count();
    expect((await POST(post(state({ version: 9, status: "SUSPENDED" }), "some-other-secret-0123456789"))).status).toBe(401);
    expect((await POST(new Request(`http://localhost${STATE}`, { method: "POST", body: JSON.stringify(state({ version: 9 })) }))).status).toBe(401);
    const good = post(state({ version: 9 }));
    const tampered = new Request(`http://localhost${STATE}`, { method: "POST", body: JSON.stringify(state({ version: 9, status: "SUSPENDED" })), headers: good.headers });
    expect((await POST(tampered)).status).toBe(401);
    expect(await counts()).toEqual(before);
    expect(await db.rtLoginAttempt.count()).toBe(attempts);
    expect(await db.rtBusiness.findFirstOrThrow()).toMatchObject({ coreStateVersion: 1, status: "ACTIVE" });
  });

  it("invalid JSON or an invalid snapshot is 400", async () => {
    await provisioned();
    expect((await POST(post(null, SECRET, "{nope"))).status).toBe(400);
    expect((await POST(post(state({ version: 0 })))).status).toBe(400);
    expect((await POST(post(state({ status: "BOGUS" })))).status).toBe(400);
  });
});

describe("GET /api/core/v1/state", () => {
  it("returns version, status and this UTC month's AI usage in half units", async () => {
    const id = await provisioned();
    await POST(post(state({ version: 3, status: "SUSPENDED" })));
    const biz = await db.rtBusiness.findUniqueOrThrow({ where: { id }, select: { timezone: true } });
    const month = aiMonth(new Date(), biz.timezone);
    await db.rtAiUsage.create({ data: { businessId: id, month, halfUnits: 7 } });
    await db.rtAiUsage.create({ data: { businessId: id, month: "2000-01", halfUnits: 99 } });
    const res = await GET(get("?coreBusinessId=core-biz-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ version: 3, status: "SUSPENDED", aiUsageMonth: { month, units: 7 } });
  });

  it("buckets the month like the quota: 2026-11-30T22:00Z in Asia/Baghdad is 2026-12", async () => {
    const id = await provisioned();
    await db.rtBusiness.update({ where: { id }, data: { timezone: "Asia/Baghdad" } });
    await db.rtAiUsage.create({ data: { businessId: id, month: "2026-12", halfUnits: 5 } });
    await db.rtAiUsage.create({ data: { businessId: id, month: "2026-11", halfUnits: 40 } });
    const report = await readCoreState("core-biz-1", new Date("2026-11-30T22:00:00.000Z"));
    expect(report?.aiUsageMonth).toEqual({ month: "2026-12", units: 5 });
  });

  it("reports units 0 when there is no usage row", async () => {
    await provisioned();
    const json = (await (await GET(get("?coreBusinessId=core-biz-1"))).json()) as { aiUsageMonth: { units: number } };
    expect(json.aiUsageMonth.units).toBe(0);
  });

  it("is signed over the query: a signature for another id, or none, is 401", async () => {
    await provisioned();
    const other = get("?coreBusinessId=other");
    const swapped = new Request(`http://localhost${STATE}?coreBusinessId=core-biz-1`, { method: "GET", headers: other.headers });
    expect((await GET(swapped)).status).toBe(401);
    expect((await GET(new Request(`http://localhost${STATE}?coreBusinessId=core-biz-1`))).status).toBe(401);
    expect((await GET(get("?coreBusinessId=core-biz-1", "some-other-secret-0123456789"))).status).toBe(401);
  });

  it("an unknown id is 404, a missing or empty id is 400", async () => {
    await provisioned();
    const res = await GET(get("?coreBusinessId=nope"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, code: "NOT_FOUND" });
    expect((await GET(get(""))).status).toBe(400);
    expect((await GET(get("?coreBusinessId="))).status).toBe(400);
  });
});

describe("GET /api/core/v1/health", () => {
  it("needs no signature, returns only {ok:true} and is not cacheable", async () => {
    await provisioned();
    const res = await healthGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("owner change in Studio", () => {
  const ownerB = { coreUserId: "core-user-2", email: "b@example.test", emailVerified: true, name: "B" };

  /** A provisioned business whose Studio owner A (core-user-1) holds the local OWNER row, and B a CASHIER row. */
  async function withOwners() {
    const id = await provisioned();
    const a = await createUser(db, { coreUserId: "core-user-1" });
    const b = await createUser(db, { coreUserId: "core-user-2" });
    await db.rtStaff.create({ data: { businessId: id, userId: a.id, role: "OWNER" } });
    await db.rtStaff.create({ data: { businessId: id, userId: b.id, role: "CASHIER" } });
    return { id, a, b };
  }
  const row = (businessId: string, userId: string) =>
    db.rtStaff.findUniqueOrThrow({ where: { businessId_userId: { businessId, userId } } });

  it("owner A -> owner B deactivates A's OWNER row with an audit row; B is left to the handoff", async () => {
    const { id, a, b } = await withOwners();
    const res = await POST(post(state({ version: 2, owner: ownerB })));
    expect(await res.json()).toEqual({ applied: true, version: 2 });

    const rowA = await row(id, a.id);
    expect(rowA.role).toBe("OWNER");
    expect(rowA.deactivatedAt).not.toBeNull();
    expect(await row(id, b.id)).toMatchObject({ role: "CASHIER", deactivatedAt: null });
    expect((await db.rtBusiness.findUniqueOrThrow({ where: { id } })).coreOwnerUserId).toBe("core-user-2");

    const audit = await db.rtAuditLog.findMany({ where: { businessId: id, action: "core.owner.demote" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: "core-sync", entity: "RtStaff", entityId: rowA.id });
  });

  it("the same owner again changes no staff row", async () => {
    const { id, a } = await withOwners();
    await POST(post(state({ version: 2 })));
    expect(await row(id, a.id)).toMatchObject({ role: "OWNER", deactivatedAt: null });
    expect(await db.rtAuditLog.count({ where: { action: "core.owner.demote" } })).toBe(0);
  });

  it("a stale snapshot with another owner is ignored and demotes nobody", async () => {
    const { id, a } = await withOwners();
    await POST(post(state({ version: 3 })));
    await POST(post(state({ version: 2, owner: ownerB })));
    expect(await row(id, a.id)).toMatchObject({ deactivatedAt: null });
  });

  it("an owner change when the previous owner never signed in here is fine", async () => {
    const id = await provisioned();
    const res = await POST(post(state({ version: 2, owner: ownerB })));
    expect(await res.json()).toEqual({ applied: true, version: 2 });
    expect((await db.rtBusiness.findUniqueOrThrow({ where: { id } })).coreOwnerUserId).toBe("core-user-2");
  });
});

describe("activity type from Studio", () => {
  /** A shop provisioned before Studio named its product: MIXED, and a snapshot without activityType. */
  async function mixedShop(): Promise<string> {
    const text = JSON.stringify({
      coreBusinessId: "core-biz-1",
      name: "Rizgar",
      activityType: "MIXED",
      branches: [{ name: "A" }],
      currencies: ["IQD"],
      state: state(),
    });
    const res = await provisionPOST(
      new Request(`http://localhost${PROVISION}`, { method: "POST", body: text, headers: signRequest("POST", PROVISION, text, SECRET) }),
    );
    expect(res.status).toBe(200);
    const { businessId } = (await res.json()) as { businessId: string };
    expect(await db.rtBusiness.findUniqueOrThrow({ where: { id: businessId } })).toMatchObject({ activityType: "MIXED" });
    return businessId;
  }

  it("a newer snapshot turns a MIXED shop into MARKET, with an audit row", async () => {
    const id = await mixedShop();
    expect(await (await POST(post(state({ version: 2, activityType: "MARKET" })))).json()).toEqual({ applied: true, version: 2 });
    expect(await db.rtBusiness.findUniqueOrThrow({ where: { id } })).toMatchObject({ activityType: "MARKET", coreStateVersion: 2 });
    const audit = await db.rtAuditLog.findMany({ where: { businessId: id, action: "core.business.activity" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.changes).toEqual({ from: "MIXED", to: "MARKET", version: 2 });
  });

  it("is idempotent and versioned: a repeat writes nothing, an older snapshot cannot move it back", async () => {
    const id = await mixedShop();
    await POST(post(state({ version: 3, activityType: "MARKET" })));
    const before = await counts();
    expect(await (await POST(post(state({ version: 3, activityType: "MARKET" })))).json()).toEqual({ applied: false, version: 3 });
    expect(await (await POST(post(state({ version: 2, activityType: "CLOTHING" })))).json()).toEqual({ applied: false, version: 3 });
    expect(await counts()).toEqual(before);
    expect(await db.rtBusiness.findUniqueOrThrow({ where: { id } })).toMatchObject({ activityType: "MARKET" });
    // The same type again in a newer snapshot: applied, but no second audit row for the type.
    await POST(post(state({ version: 4, activityType: "MARKET" })));
    expect(await db.rtAuditLog.count({ where: { businessId: id, action: "core.business.activity" } })).toBe(1);
  });

  it("later changes in Studio follow; a snapshot without activityType keeps the stored one", async () => {
    const id = await mixedShop();
    await POST(post(state({ version: 2, activityType: "MARKET" })));
    await POST(post(state({ version: 3, activityType: "ELECTRONICS" })));
    expect(await db.rtBusiness.findUniqueOrThrow({ where: { id } })).toMatchObject({ activityType: "ELECTRONICS" });
    expect(await (await POST(post(state({ version: 4 })))).json()).toEqual({ applied: true, version: 4 });
    expect(await db.rtBusiness.findUniqueOrThrow({ where: { id } })).toMatchObject({ activityType: "ELECTRONICS" });
  });

  it("a type Studio never sends (MIXED, BEAUTY) is a 400 and changes nothing", async () => {
    const id = await mixedShop();
    for (const activityType of ["MIXED", "BEAUTY", "SUPERMARKET"]) {
      expect((await POST(post(state({ version: 2, activityType })))).status).toBe(400);
    }
    expect(await db.rtBusiness.findUniqueOrThrow({ where: { id } })).toMatchObject({ activityType: "MIXED", coreStateVersion: 1 });
  });

  it("a provision repeat with a newer snapshot moves the existing shop's type too", async () => {
    const id = await mixedShop();
    const text = JSON.stringify({
      coreBusinessId: "core-biz-1",
      name: "Rizgar",
      activityType: "MARKET",
      branches: [{ name: "A" }],
      currencies: ["IQD"],
      state: state({ version: 2, activityType: "MARKET" }),
    });
    const res = await provisionPOST(
      new Request(`http://localhost${PROVISION}`, { method: "POST", body: text, headers: signRequest("POST", PROVISION, text, SECRET) }),
    );
    expect(res.status).toBe(200);
    expect(await db.rtBusiness.findUniqueOrThrow({ where: { id } })).toMatchObject({ activityType: "MARKET", coreStateVersion: 2 });
  });
});
