import { afterEach, describe, expect, it, vi } from "vitest";
import { can } from "@/server/domain/permissions";
import {
  grantSupport,
  resolveSupportActor,
  revokeSupport,
  runSupportRead,
  SupportAccessError,
  type SupportScope,
} from "@/server/admin/support";
import { ScopeError } from "@/server/framework/scoped-db";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan, createPlatformAdmin, createUser } from "../helpers/fixtures";

const { db } = useTestDb();

afterEach(() => {
  vi.useRealTimers();
});

const REASON = "العميل طلب مراجعة المخزون";
const HOUR = 3_600_000;
let n = 0;
const key = () => `k${++n}`;

async function business(label: string) {
  const w = await createBusinessWithStaff(db, {
    branches: ["Main"],
    staff: [
      { key: "owner", role: "OWNER" },
      { key: "manager", role: "MANAGER", branches: ["Main"] },
      { key: "cashier", role: "CASHIER", branches: ["Main"] },
    ],
  });
  await db.rtBusiness.update({ where: { id: w.business.id }, data: { status: "ACTIVE", name: label } });
  await db.rtSubscription.create({
    data: {
      businessId: w.business.id,
      planCode: "basic",
      status: "ACTIVE",
      currentPeriodStart: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  const owner = (k = key()) => ({ userId: w.staff.owner!.user.id, businessId: w.business.id, idempotencyKey: k });
  return { ...w, owner };
}

async function world() {
  await createPlan(db);
  const a = await business("A");
  const admin = await createPlatformAdmin(db);
  const grantFor = async (scopes: SupportScope[] = ["STOCK_READ"], hours = 2) => {
    const r = await grantSupport({ granteeId: admin.id, scopes, reason: REASON, hours }, a.owner());
    if (!r.ok) throw new Error(`grant failed: ${r.code}`);
    return r.value.grantId;
  };
  return { a, admin, grantFor };
}

describe("grantSupport", () => {
  it("creates a time-boxed grant for a platform admin and audits it", async () => {
    const { a, admin } = await world();
    const before = Date.now();
    const r = await grantSupport(
      { granteeId: admin.id, scopes: ["CATALOG_READ", "STOCK_READ", "STOCK_READ"], reason: `  ${REASON}  `, hours: 24 },
      a.owner(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await db.rtSupportGrant.findUniqueOrThrow({ where: { id: r.value.grantId } });
    expect(row).toMatchObject({
      businessId: a.business.id,
      granteeId: admin.id,
      grantedById: a.staff.owner!.user.id,
      reason: REASON,
      revokedAt: null,
    });
    expect([...row.scopes].sort()).toEqual(["CATALOG_READ", "STOCK_READ"]);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(24 * HOUR);
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // The database stores the dotted strings.
    const raw = await db.$queryRaw<{ s: string[] }[]>`SELECT scopes::text[] AS s FROM "RtSupportGrant" WHERE id = ${row.id}`;
    expect([...raw[0]!.s].sort()).toEqual(["catalog.read", "stock.read"]);
    const audit = await db.rtAuditLog.findFirstOrThrow({ where: { action: "support.grant" } });
    expect(audit).toMatchObject({ businessId: a.business.id, entityId: row.id, actorId: a.staff.owner!.user.id });
  });

  it("73 hours or a 9-character reason is refused", async () => {
    const { a, admin } = await world();
    const bad = [
      { hours: 73, reason: REASON },
      { hours: 0, reason: REASON },
      { hours: 1.5, reason: REASON },
      { hours: "2", reason: REASON },
      { hours: -1, reason: REASON },
      { hours: 2, reason: "123456789" },
      { hours: 2, reason: "         123456789        " },
    ];
    for (const b of bad) {
      const r = await grantSupport({ granteeId: admin.id, scopes: ["STOCK_READ"], ...b }, a.owner());
      expect(r, JSON.stringify(b)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
    expect(await grantSupport({ granteeId: admin.id, scopes: [], reason: REASON, hours: 2 }, a.owner())).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(await grantSupport({ granteeId: admin.id, scopes: ["NOPE"], reason: REASON, hours: 2 }, a.owner())).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(await db.rtSupportGrant.count()).toBe(0);
    // The boundaries themselves are accepted.
    for (const [hours, reason] of [
      [72, "1234567890"],
      [1, REASON],
    ] as const) {
      const r = await grantSupport({ granteeId: admin.id, scopes: ["STOCK_READ"], reason, hours }, a.owner());
      expect(r.ok, `${hours}`).toBe(true);
    }
  });

  it("the database itself refuses a short reason, no scopes, and more than 72 hours", async () => {
    const { a, admin } = await world();
    const now = new Date();
    const base = {
      businessId: a.business.id,
      granteeId: admin.id,
      grantedById: a.staff.owner!.user.id,
      scopes: ["STOCK_READ"] as SupportScope[],
      reason: REASON,
      createdAt: now,
      expiresAt: new Date(now.getTime() + HOUR),
    };
    await expect(db.rtSupportGrant.create({ data: { ...base, reason: "123456789" } })).rejects.toThrow();
    await expect(db.rtSupportGrant.create({ data: { ...base, scopes: [] } })).rejects.toThrow();
    await expect(db.rtSupportGrant.create({ data: { ...base, expiresAt: now } })).rejects.toThrow();
    await expect(db.rtSupportGrant.create({ data: { ...base, expiresAt: new Date(now.getTime() + 72 * HOUR + 1000) } })).rejects.toThrow();
    await expect(db.rtSupportGrant.create({ data: { ...base, expiresAt: new Date(now.getTime() + 72 * HOUR) } })).resolves.toBeTruthy();
  });

  it("only the OWNER can grant", async () => {
    const { a, admin } = await world();
    for (const who of ["manager", "cashier"]) {
      const r = await grantSupport(
        { granteeId: admin.id, scopes: ["STOCK_READ"], reason: REASON, hours: 2 },
        { userId: a.staff[who]!.user.id, businessId: a.business.id, idempotencyKey: key() },
      );
      expect(r, who).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    expect(await db.rtSupportGrant.count()).toBe(0);
  });

  it("refuses a grantee who is not a platform admin", async () => {
    const { a } = await world();
    const shopUser = await createUser(db);
    const ghost = "no-such-user";
    for (const granteeId of [shopUser.id, a.staff.cashier!.user.id, ghost]) {
      const r = await grantSupport({ granteeId, scopes: ["STOCK_READ"], reason: REASON, hours: 2 }, a.owner());
      expect(r, granteeId).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
    expect(await db.rtSupportGrant.count()).toBe(0);
  });

  it("is idempotent for the same key", async () => {
    const { a, admin } = await world();
    const input = { granteeId: admin.id, scopes: ["STOCK_READ" as const], reason: REASON, hours: 2 };
    const k = key();
    const first = await grantSupport(input, a.owner(k));
    const second = await grantSupport(input, a.owner(k));
    expect(second).toEqual(first);
    expect(await db.rtSupportGrant.count()).toBe(1);
  });
});

describe("revokeSupport", () => {
  it("ends a grant at once; revoking twice is fine and keeps the first revokedAt", async () => {
    const { a, admin, grantFor } = await world();
    const grantId = await grantFor();
    expect(await resolveSupportActor(grantId, admin.id)).toMatchObject({ viaSupportGrantId: grantId });
    expect(await revokeSupport({ grantId }, a.owner())).toMatchObject({ ok: true });
    const first = (await db.rtSupportGrant.findUniqueOrThrow({ where: { id: grantId } })).revokedAt;
    expect(first).not.toBeNull();
    await expect(resolveSupportActor(grantId, admin.id)).rejects.toBeInstanceOf(SupportAccessError);
    await new Promise((r) => setTimeout(r, 15));
    expect(await revokeSupport({ grantId }, a.owner())).toMatchObject({ ok: true });
    expect((await db.rtSupportGrant.findUniqueOrThrow({ where: { id: grantId } })).revokedAt).toEqual(first);
    expect(await db.rtAuditLog.count({ where: { action: "support.revoke" } })).toBe(2);
  });

  it("treats a grant of another business as NOT_FOUND and only the OWNER may revoke", async () => {
    const { a, admin, grantFor } = await world();
    const b = await business("B");
    const grantId = await grantFor();
    expect(await revokeSupport({ grantId }, b.owner())).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await revokeSupport({ grantId: "missing" }, a.owner())).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const manager = { userId: a.staff.manager!.user.id, businessId: a.business.id, idempotencyKey: key() };
    expect(await revokeSupport({ grantId }, manager)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect((await db.rtSupportGrant.findUniqueOrThrow({ where: { id: grantId } })).revokedAt).toBeNull();
    await expect(resolveSupportActor(grantId, admin.id)).resolves.toBeTruthy();
  });

  it("still works while the business is READ_ONLY (suspended)", async () => {
    const { a, admin, grantFor } = await world();
    const grantId = await grantFor();
    await db.rtBusiness.update({ where: { id: a.business.id }, data: { status: "SUSPENDED" } });
    expect(await revokeSupport({ grantId }, a.owner())).toMatchObject({ ok: true });
    await expect(resolveSupportActor(grantId, admin.id)).rejects.toBeInstanceOf(SupportAccessError);
    // Granting is still a write: refused while read-only.
    expect(
      await grantSupport({ granteeId: admin.id, scopes: ["STOCK_READ"], reason: REASON, hours: 2 }, a.owner()),
    ).toMatchObject({ ok: false, code: "READ_ONLY" });
  });
});

describe("resolveSupportActor", () => {
  it("a platform admin without a grant is refused like a stranger", async () => {
    const { admin, grantFor } = await world();
    const stranger = await createUser(db);
    const grantId = await grantFor();
    const reasons: (string | undefined)[] = [];
    for (const [g, u] of [
      ["no-such-grant", admin.id], // admin with no grant at all
      ["no-such-grant", stranger.id], // stranger with no grant
      [grantId, stranger.id], // stranger using the admin's grant
    ] as const) {
      const err = await resolveSupportActor(g, u).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SupportAccessError);
      reasons.push((err as SupportAccessError).reason);
    }
    // The admin and the stranger get the identical refusal when no grant exists.
    expect(reasons[0]).toBe(reasons[1]);
    // And through runSupportRead the read never runs.
    let ran = false;
    await expect(
      runSupportRead("no-such-grant", admin.id, "STOCK_READ", async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(SupportAccessError);
    expect(ran).toBe(false);
    expect(await db.rtAuditLog.count({ where: { action: "support.read" } })).toBe(0);
  });

  it("returns a read-only AUDITOR actor tagged with the grant", async () => {
    const { a, admin, grantFor } = await world();
    const grantId = await grantFor(["CATALOG_READ", "SALES_READ"]);
    const actor = await resolveSupportActor(grantId, admin.id);
    expect(actor).toMatchObject({
      userId: admin.id,
      businessId: a.business.id,
      role: "AUDITOR",
      branchIds: "ALL",
      viaSupportGrantId: grantId,
      readOnly: true,
    });
    expect([...actor.scopes].sort()).toEqual(["CATALOG_READ", "SALES_READ"]);
  });

  it("another platform admin cannot use someone else's grant", async () => {
    const { admin, grantFor } = await world();
    const other = await createPlatformAdmin(db);
    const grantId = await grantFor();
    await expect(resolveSupportActor(grantId, other.id)).rejects.toBeInstanceOf(SupportAccessError);
    await expect(resolveSupportActor(grantId, admin.id)).resolves.toBeTruthy();
  });

  it("a revoked or expired grant reads nothing", async () => {
    const { a, admin, grantFor } = await world();
    const grantId = await grantFor(["STOCK_READ"], 2);
    const { expiresAt } = await db.rtSupportGrant.findUniqueOrThrow({ where: { id: grantId } });
    const read = () => runSupportRead(grantId, admin.id, "STOCK_READ", async ({ db: tx }) => tx.rtBranch.count());
    // Only Date is faked (timers stay real so the database driver keeps working).
    const at = (ms: number) => vi.useFakeTimers({ toFake: ["Date"], now: ms });

    // One millisecond before expiry works; the exact instant and later are refused.
    at(expiresAt.getTime() - 1);
    await expect(read()).resolves.toBe(1);
    at(expiresAt.getTime());
    await expect(read()).rejects.toBeInstanceOf(SupportAccessError);
    await expect(resolveSupportActor(grantId, admin.id)).rejects.toBeInstanceOf(SupportAccessError);
    at(expiresAt.getTime() + 1);
    await expect(read()).rejects.toBeInstanceOf(SupportAccessError);
    vi.useRealTimers();

    // Revoke followed by an immediate read.
    await expect(read()).resolves.toBe(1);
    await revokeSupport({ grantId }, a.owner());
    await expect(read()).rejects.toBeInstanceOf(SupportAccessError);
    // Only the one successful pre-expiry read and the one pre-revoke read left audit rows.
    expect(await db.rtAuditLog.count({ where: { action: "support.read" } })).toBe(2);
  });

  it("an admin who is no longer a platform admin loses the grant", async () => {
    const { admin, grantFor } = await world();
    const grantId = await grantFor();
    await db.rtPlatformAdmin.delete({ where: { userId: admin.id } });
    await expect(resolveSupportActor(grantId, admin.id)).rejects.toBeInstanceOf(SupportAccessError);
  });

  it("a CLOSED or ARCHIVED business refuses reads even with a live grant; SETUP, SUSPENDED and READ_ONLY allow them", async () => {
    const { a, admin, grantFor } = await world();
    const grantId = await grantFor();
    const setStatus = (status: "SETUP" | "ACTIVE" | "SUSPENDED" | "ARCHIVED") =>
      db.rtBusiness.update({ where: { id: a.business.id }, data: { status } });

    for (const status of ["SETUP", "SUSPENDED", "ACTIVE"] as const) {
      await setStatus(status);
      await expect(resolveSupportActor(grantId, admin.id), status).resolves.toBeTruthy();
    }
    await setStatus("ARCHIVED");
    await expect(resolveSupportActor(grantId, admin.id)).rejects.toMatchObject({ reason: "BUSINESS_CLOSED" });

    // Gate CLOSED from the subscription (retention over) on an ACTIVE business.
    await setStatus("ACTIVE");
    await db.rtSubscription.updateMany({
      where: { businessId: a.business.id },
      data: { currentPeriodEnd: new Date(Date.now() - 400 * 86_400_000) },
    });
    await expect(resolveSupportActor(grantId, admin.id)).rejects.toMatchObject({ reason: "BUSINESS_CLOSED" });
    // READ_ONLY (within retention after the period) still allows the read.
    await db.rtSubscription.updateMany({
      where: { businessId: a.business.id },
      data: { currentPeriodEnd: new Date(Date.now() - 30 * 86_400_000) },
    });
    await expect(resolveSupportActor(grantId, admin.id)).resolves.toBeTruthy();
  });

  it("maps SupportAccessError to FORBIDDEN in an action result", async () => {
    const { toFailure } = await import("@/server/framework/action");
    expect(toFailure("x", new SupportAccessError("EXPIRED"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});

describe("runSupportRead", () => {
  it("every support read writes an audit row first, and fails if the audit cannot be written", async () => {
    const { a, admin, grantFor } = await world();
    const grantId = await grantFor(["STOCK_READ"]);

    // Success: one audit row naming the grant and scope, holding no read payload.
    const value = await runSupportRead(grantId, admin.id, "STOCK_READ", async ({ db: tx, actor }) => ({
      branches: await tx.rtBranch.findMany({ select: { name: true } }),
      actor: actor.viaSupportGrantId,
    }));
    expect(value.branches).toEqual([{ name: "Main" }]);
    const rows = await db.rtAuditLog.findMany({ where: { action: "support.read" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ businessId: a.business.id, actorId: admin.id, entityId: grantId });
    expect(rows[0]!.changes).toEqual({
      grantId,
      scope: "stock.read",
      actorId: admin.id,
      viaSupportGrantId: grantId,
    });
    expect(JSON.stringify(rows[0]!.changes)).not.toContain("Main"); // no read payload

    // Failure (proves the audit insert comes first): a CHECK that rejects support.read rows makes the audit insert fail.
    await db.$executeRawUnsafe(
      `ALTER TABLE "RtAuditLog" ADD CONSTRAINT "test_no_support_read" CHECK (action <> 'support.read') NOT VALID`,
    );
    try {
      let ran = false;
      await expect(
        runSupportRead(grantId, admin.id, "STOCK_READ", async () => {
          ran = true;
          return "secret";
        }),
      ).rejects.toThrow();
      expect(ran).toBe(false);
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "RtAuditLog" DROP CONSTRAINT "test_no_support_read"`);
    }
    expect(await db.rtAuditLog.count({ where: { action: "support.read" } })).toBe(1);
  });

  it("a read that throws still leaves its audit row", async () => {
    const { admin, grantFor } = await world();
    const grantId = await grantFor(["STOCK_READ"]);
    await expect(
      runSupportRead(grantId, admin.id, "STOCK_READ", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.rtAuditLog.count({ where: { action: "support.read" } })).toBe(1);
  });

  it("the grant is re-resolved for the read: a revoke between audit and read is honoured", async () => {
    const { admin, grantFor } = await world();
    const grantId = await grantFor(["STOCK_READ"]);
    // A trigger revokes the grant right after the audit row commits, i.e. between the two transactions.
    await db.$executeRawUnsafe(`CREATE FUNCTION test_revoke_after_audit() RETURNS trigger AS $$
      BEGIN UPDATE "RtSupportGrant" SET "revokedAt" = now() WHERE id = NEW."entityId"; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(
      `CREATE TRIGGER test_revoke_after_audit AFTER INSERT ON "RtAuditLog" FOR EACH ROW WHEN (NEW.action = 'support.read') EXECUTE FUNCTION test_revoke_after_audit()`,
    );
    try {
      let ran = false;
      await expect(
        runSupportRead(grantId, admin.id, "STOCK_READ", async () => {
          ran = true;
        }),
      ).rejects.toBeInstanceOf(SupportAccessError);
      expect(ran).toBe(false);
      expect(await db.rtAuditLog.count({ where: { action: "support.read" } })).toBe(1);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER test_revoke_after_audit ON "RtAuditLog"`);
      await db.$executeRawUnsafe(`DROP FUNCTION test_revoke_after_audit()`);
    }
  });

  it("the exported functions ignore any clock argument: expiry is judged on the real clock", async () => {
    const { admin, grantFor } = await world();
    const grantId = await grantFor(["STOCK_READ"], 1);
    await db.rtSupportGrant.update({ where: { id: grantId }, data: { revokedAt: null } });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * HOUR });
    const resolve = resolveSupportActor as unknown as (...a: unknown[]) => Promise<unknown>;
    const run = runSupportRead as unknown as (...a: unknown[]) => Promise<unknown>;
    await expect(resolve(grantId, admin.id, new Date(0))).rejects.toBeInstanceOf(SupportAccessError);
    await expect(run(grantId, admin.id, "STOCK_READ", async () => 1, new Date(0))).rejects.toBeInstanceOf(SupportAccessError);
    expect(resolveSupportActor.length).toBeLessThanOrEqual(2);
    expect(runSupportRead.length).toBeLessThanOrEqual(4);
  });

  it("refuses a scope the grant does not include, with no audit row", async () => {
    const { admin, grantFor } = await world();
    const grantId = await grantFor(["STOCK_READ"]);
    let ran = false;
    for (const scope of ["CATALOG_READ", "SALES_READ"] as const) {
      await expect(
        runSupportRead(grantId, admin.id, scope, async () => {
          ran = true;
        }),
      ).rejects.toMatchObject({ reason: "SCOPE_NOT_GRANTED" });
    }
    expect(ran).toBe(false);
    expect(await db.rtAuditLog.count({ where: { action: "support.read" } })).toBe(0);
  });

  it("a grant for business A cannot read business B", async () => {
    const { a, admin, grantFor } = await world();
    const b = await business("B");
    await db.rtBranch.create({ data: { businessId: b.business.id, name: "Secret B" } });
    const grantId = await grantFor(["STOCK_READ"]);
    const names = await runSupportRead(grantId, admin.id, "STOCK_READ", async ({ db: tx }) => {
      const mine = await tx.rtBranch.findMany({ select: { name: true, businessId: true } });
      // Even an explicit attempt to widen the filter stays inside business A.
      const widened = await tx.rtBranch.findMany({ where: { OR: [{ businessId: b.business.id }, {}] } });
      const other = await tx.rtBranch.findFirst({ where: { businessId: b.business.id } });
      // Relations reached through include / relation filters stay inside business A as well.
      const withBusiness = await tx.rtBranch.findMany({ include: { business: { select: { id: true, name: true } } } });
      const viaRelation = await tx.rtBranch.findMany({ where: { business: { id: b.business.id } } });
      expect(withBusiness.every((r) => r.business.id === a.business.id)).toBe(true);
      expect(viaRelation).toEqual([]);
      return { mine, widened, other };
    });
    expect(names.mine.every((r) => r.businessId === a.business.id)).toBe(true);
    expect(names.widened.every((r) => r.businessId === a.business.id)).toBe(true);
    expect(names.other).toBeNull();
    expect(JSON.stringify(names)).not.toContain("Secret B");
  });

  it("a support actor cannot write and never sees cost", async () => {
    const { a, admin, grantFor } = await world();
    const grantId = await grantFor(["STOCK_READ", "CATALOG_READ", "SALES_READ"]);
    const branchId = (await db.rtBranch.findFirstOrThrow({ where: { businessId: a.business.id } })).id;

    await runSupportRead(grantId, admin.id, "STOCK_READ", async ({ db: tx, actor }) => {
      // No cost and no export for the support role.
      expect(can(actor.role, "cost.view")).toBe(false);
      expect(can(actor.role, "data.export")).toBe(false);
      expect(can(actor.role, "support.grant")).toBe(false);
      expect(actor.readOnly).toBe(true);

      const attempts: Record<string, () => Promise<unknown>> = {
        create: () => tx.rtBranch.create({ data: { businessId: actor.businessId, name: "x" } }),
        createMany: () => tx.rtBranch.createMany({ data: [{ businessId: actor.businessId, name: "x" }] }),
        update: () => tx.rtBranch.update({ where: { id: branchId }, data: { name: "x" } }),
        updateMany: () => tx.rtBranch.updateMany({ where: {}, data: { name: "x" } }),
        upsert: () =>
          tx.rtBranch.upsert({ where: { id: branchId }, update: { name: "x" }, create: { businessId: actor.businessId, name: "x" } }),
        delete: () => tx.rtBranch.delete({ where: { id: branchId } }),
        deleteMany: () => tx.rtBranch.deleteMany({}),
        "grant revoke": () => tx.rtSupportGrant.updateMany({ where: {}, data: { revokedAt: new Date() } }),
        queryRaw: () => (tx as unknown as { $queryRaw: (s: TemplateStringsArray) => Promise<unknown> }).$queryRaw`SELECT 1`,
        executeRaw: () => (tx as unknown as { $executeRaw: (s: TemplateStringsArray) => Promise<unknown> }).$executeRaw`DELETE FROM "RtBranch"`,
        transaction: () => (tx as unknown as { $transaction: (f: () => Promise<unknown>) => Promise<unknown> }).$transaction(async () => 1),
        extends: () => (tx as unknown as { $extends: (x: object) => Promise<unknown> }).$extends({}),
        executeRawUnsafe: () => tx.$executeRawUnsafe(`DELETE FROM "RtBranch"`),
      };
      for (const [name, attempt] of Object.entries(attempts)) {
        const err = await attempt().then(
          () => null,
          (e: unknown) => e,
        );
        expect(err, name).toBeInstanceOf(ScopeError);
        expect((err as ScopeError).code, name).toBe("READ_ONLY_ACTOR");
      }
    });
    // Nothing changed.
    expect(await db.rtBranch.count({ where: { businessId: a.business.id } })).toBe(1);
    expect((await db.rtBranch.findUniqueOrThrow({ where: { id: branchId } })).name).toBe("Main");
    expect((await db.rtSupportGrant.findUniqueOrThrow({ where: { id: grantId } })).revokedAt).toBeNull();
  });

  it("support-read audit rows name the grant and scope for each scope", async () => {
    const { admin, grantFor } = await world();
    const grantId = await grantFor(["CATALOG_READ", "STOCK_READ", "SALES_READ"]);
    for (const scope of ["CATALOG_READ", "STOCK_READ", "SALES_READ"] as const) {
      await runSupportRead(grantId, admin.id, scope, async () => undefined);
    }
    const rows = await db.rtAuditLog.findMany({ where: { action: "support.read" } });
    expect(rows.map((r) => (r.changes as { scope: string }).scope).sort()).toEqual(["catalog.read", "sales.read", "stock.read"]);
  });
});
