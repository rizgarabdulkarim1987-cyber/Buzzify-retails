import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completeHandoff } from "@/server/admin/core-handoff";
import { provisionFromCore } from "@/server/admin/core-provision";
import { WINDOW_MS as LOGIN_WINDOW_MS } from "@/server/auth/login-throttle";
import { handoffNonce, signHandoffForTests } from "@/server/core/handoff";
import { CORE_RATE_LIMIT, coreRateLimit, pruneAttempts } from "@/server/core/rate-limit";
import { applyCoreState, coreStateSchema, type CoreState } from "@/server/core/state";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff } from "../helpers/fixtures";

const { db } = useTestDb();

const SECRET = "review-handoff-secret-1";
const ENV = ["CORE_HANDOFF_SECRET", "CORE_HANDOFF_SECRET_PREVIOUS", "CORE_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CORE_HANDOFF_SECRET = SECRET;
  process.env.CORE_BASE_URL = "https://studio.example";
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function state(coreBusinessId: string, version: number, over: Record<string, unknown> = {}, planOver: Record<string, unknown> = {}): CoreState {
  return coreStateSchema.parse({
    coreBusinessId,
    version,
    status: "ACTIVE",
    plan: { code: "pro", name: "Pro", maxBranches: 3, maxTerminals: 4, maxUsers: 9, storageMb: 2048, aiMonthly: 50, ...planOver },
    subscription: {
      status: "ACTIVE",
      trialEndsAt: null,
      currentPeriodStart: "2026-11-01T00:00:00.000Z",
      currentPeriodEnd: "2099-12-01T00:00:00.000Z",
      graceDays: 5,
    },
    aiIntake: false,
    owner: { coreUserId: "core-user-old", email: "old@example.test", emailVerified: true, name: "Old" },
    ...over,
  });
}

describe("handoff and owner change are serialised on the business row", () => {
  it("a snapshot that moves ownership, committed first, leaves the old owner's handoff without an OWNER row", async () => {
    const w = await createBusinessWithStaff(db);
    await db.rtBusiness.update({
      where: { id: w.business.id },
      data: { coreBusinessId: "core-biz-race", coreOwnerUserId: "core-user-old", coreStateVersion: 1, status: "ACTIVE" },
    });

    // The sync transaction is open (row locked, new owner set) while the old owner's handoff starts.
    let release!: () => void;
    let applied!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const appliedP = new Promise<void>((r) => (applied = r));
    const sync = db.$transaction(
      async (tx) => {
        await applyCoreState(tx, w.business.id, state("core-biz-race", 2, { owner: { coreUserId: "core-user-new", email: "new@example.test", emailVerified: true, name: "New" } }));
        applied();
        await held;
      },
      { timeout: 20_000 },
    );
    await appliedP;

    const stateValue = "state-value-for-race-test-0123456789abcdef";
    const iat = Math.floor(Date.now() / 1000);
    const token = signHandoffForTests(
      {
        aud: "retail",
        iat,
        exp: iat + 60,
        nonce: handoffNonce(stateValue),
        jti: randomUUID(),
        coreUserId: "core-user-old",
        email: "old@example.test",
        emailVerified: true,
        name: "Old",
        coreBusinessId: "core-biz-race",
      },
      SECRET,
    );
    const handoff = completeHandoff({
      token,
      state: stateValue,
      stateCookie: `${stateValue}.${Buffer.from("/retail/home").toString("base64url")}`,
    });
    // Give the handoff time to reach the lock, then let the sync commit.
    await new Promise((r) => setTimeout(r, 500));
    release();
    await sync;
    const outcome = await handoff;

    // Whatever the handoff answers, the old owner must not have been (re)made OWNER.
    expect(outcome.ok).toBe(true);
    const oldUser = await db.user.findUniqueOrThrow({ where: { coreUserId: "core-user-old" } });
    expect(await db.rtStaff.count({ where: { businessId: w.business.id, userId: oldUser.id, role: "OWNER" } })).toBe(0);
    expect((await db.rtBusiness.findUniqueOrThrow({ where: { id: w.business.id } })).coreOwnerUserId).toBe("core-user-new");
  });
});

describe("core plans are per business", () => {
  const provision = (coreBusinessId: string, v: number, planOver: Record<string, unknown> = {}) =>
    provisionFromCore({
      coreBusinessId,
      name: `Shop ${coreBusinessId}`,
      activityType: "MARKET",
      capabilities: [],
      branches: [{ name: "Main" }],
      currencies: ["IQD"],
      state: state(coreBusinessId, v, {}, planOver),
    });

  it("a delayed snapshot of business Y with the same plan code does not change X's limits", async () => {
    const x = await provision("core-x", 1, { maxBranches: 3, aiMonthly: 50 });
    await provision("core-y", 1, { maxBranches: 3, aiMonthly: 50 });
    await db.$transaction((tx) => applyCoreState(tx, x.businessId, state("core-x", 1, {}, { aiMonthly: 50 })));
    const y = await db.rtBusiness.findUniqueOrThrow({ where: { coreBusinessId: "core-y" } });
    await db.$transaction((tx) => applyCoreState(tx, y.id, state("core-y", 2, {}, { maxBranches: 9, aiMonthly: 1 })));

    const plans = await db.rtPlan.findMany({ orderBy: { code: "asc" } });
    expect(plans.map((p) => p.code)).toEqual(["core:core-x:pro", "core:core-y:pro"]);
    expect(plans[0]).toMatchObject({ maxBranches: 3, aiMonthly: 50 });
    expect(plans[1]).toMatchObject({ maxBranches: 9, aiMonthly: 1 });
    expect((await db.rtSubscription.findFirstOrThrow({ where: { businessId: x.businessId } })).planCode).toBe("core:core-x:pro");
  });
});

describe("core rate limits", () => {
  it("handoff traffic cannot use up the sync bucket (and the reverse)", async () => {
    for (let i = 0; i < CORE_RATE_LIMIT; i++) expect(await coreRateLimit("handoff", "198.51.100.9")).toEqual({ ok: true });
    expect(await coreRateLimit("handoff", "198.51.100.9")).toEqual({ ok: false });
    expect(await coreRateLimit("sync", "198.51.100.9")).toEqual({ ok: true });
  });

  it("prunes attempts older than the longest window in use, and only those", async () => {
    const now = new Date();
    await db.rtLoginAttempt.createMany({
      data: [
        { key: "old", at: new Date(now.getTime() - LOGIN_WINDOW_MS - 1000) },
        { key: "recent", at: new Date(now.getTime() - LOGIN_WINDOW_MS + 60_000) },
      ],
    });
    expect(await pruneAttempts(now)).toBe(1);
    expect((await db.rtLoginAttempt.findMany()).map((r) => r.key)).toEqual(["recent"]);
  });
});
