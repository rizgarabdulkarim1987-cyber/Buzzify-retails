import { describe, expect, it } from "vitest";
import { overrideFeature, setBusinessStatus } from "@/server/admin/lifecycle";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlatformAdmin, createUser } from "../helpers/fixtures";

const { db } = useTestDb();

const ARABIC = /[؀-ۿ]/;
const REASON = "طلب المالك عبر الهاتف";

async function world() {
  const { business } = await createBusinessWithStaff(db);
  const adminUser = await createPlatformAdmin(db);
  const admin = (key: string) => ({ userId: adminUser.id, idempotencyKey: key });
  const status = async () => db.rtBusiness.findUniqueOrThrow({ where: { id: business.id } });
  let n = 0;
  /** Moves the business to `next` using its current version. */
  const move = async (next: string, reason = REASON) =>
    setBusinessStatus(
      { businessId: business.id, next, reason, expectedVersion: (await status()).version },
      admin(`m${++n}`),
    );
  return { businessId: business.id, admin, adminUser, status, move };
}

describe("setBusinessStatus", () => {
  it("follows the allowed transitions and audits each one", async () => {
    const w = await world();
    expect(await w.move("ACTIVE")).toMatchObject({ ok: true, value: { status: "ACTIVE" } });
    expect(await w.move("SUSPENDED")).toMatchObject({ ok: true, value: { status: "SUSPENDED" } });
    expect(await w.move("ACTIVE")).toMatchObject({ ok: true });
    expect(await w.move("ARCHIVED")).toMatchObject({ ok: true, value: { status: "ARCHIVED" } });
    expect((await w.status()).version).toBe(5);
    const audit = await db.rtAuditLog.findMany({ orderBy: { at: "asc" } });
    expect(audit).toHaveLength(4);
    expect(audit[0]).toMatchObject({
      businessId: w.businessId,
      actorId: w.adminUser.id,
      action: "platform.business.setStatus",
      entity: "RtBusiness",
      entityId: w.businessId,
      changes: { from: "SETUP", to: "ACTIVE", reason: REASON },
    });
  });

  it("SUSPENDED can be archived directly", async () => {
    const w = await world();
    await w.move("ACTIVE");
    await w.move("SUSPENDED");
    expect(await w.move("ARCHIVED")).toMatchObject({ ok: true });
  });

  it("ARCHIVED cannot return to ACTIVE", async () => {
    const w = await world();
    await w.move("ACTIVE");
    await w.move("ARCHIVED");
    for (const next of ["ACTIVE", "SUSPENDED", "SETUP", "ARCHIVED"]) {
      const r = await w.move(next);
      expect(r, next).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
      expect((r as { message: string }).message).toMatch(ARABIC);
    }
    expect((await w.status()).status).toBe("ARCHIVED");
  });

  it("refuses the other disallowed transitions", async () => {
    const w = await world();
    for (const next of ["SUSPENDED", "ARCHIVED", "SETUP"]) {
      expect(await w.move(next), next).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
    }
    await w.move("ACTIVE");
    expect(await w.move("SETUP")).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
    expect(await w.move("ACTIVE")).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
    expect(await db.rtAuditLog.count()).toBe(1);
  });

  it("a reason under 10 characters, a stale version, an unknown business and a non-admin are refused", async () => {
    const w = await world();
    expect(await w.move("ACTIVE", "قصير")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await w.move("ACTIVE", "         x         ")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(
      await setBusinessStatus({ businessId: w.businessId, next: "ACTIVE", reason: REASON, expectedVersion: 9 }, w.admin("s")),
    ).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    expect(
      await setBusinessStatus({ businessId: "nope", next: "ACTIVE", reason: REASON, expectedVersion: 1 }, w.admin("n")),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const user = await createUser(db);
    expect(
      await setBusinessStatus(
        { businessId: w.businessId, next: "ACTIVE", reason: REASON, expectedVersion: 1 },
        { userId: user.id, idempotencyKey: "u" },
      ),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await w.status()).toMatchObject({ status: "SETUP", version: 1 });
    expect(await db.rtAuditLog.count()).toBe(0);
  });
});

describe("overrideFeature", () => {
  it("records the override and an audit row", async () => {
    const w = await world();
    const r = await overrideFeature(
      { businessId: w.businessId, feature: "ai.assistant", enabled: true, reason: REASON },
      w.admin("o1"),
    );
    expect(r.ok).toBe(true);
    const row = await db.rtFeatureOverride.findFirstOrThrow();
    expect(row).toMatchObject({
      businessId: w.businessId,
      feature: "ai.assistant",
      enabled: true,
      reason: REASON,
      grantedById: w.adminUser.id,
    });
    expect(await db.rtAuditLog.findFirstOrThrow()).toMatchObject({
      businessId: w.businessId,
      action: "platform.feature.override",
      entity: "RtFeatureOverride",
      entityId: row.id,
      changes: { feature: "ai.assistant", enabled: true, reason: REASON },
    });
  });

  it("override without a reason of 10 characters is refused", async () => {
    const w = await world();
    for (const reason of ["", "123456789", "   قصير   "]) {
      const r = await overrideFeature({ businessId: w.businessId, feature: "x", enabled: false, reason }, w.admin(reason || "e"));
      expect(r, JSON.stringify(reason)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
    expect(await overrideFeature({ businessId: w.businessId, feature: "x", enabled: false }, w.admin("none"))).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(await db.rtFeatureOverride.count()).toBe(0);
    expect(await db.rtAuditLog.count()).toBe(0);
    expect(await db.rtIdempotency.count()).toBe(0);
  });

  it("an unknown business is NOT_FOUND and a non-admin is FORBIDDEN", async () => {
    const w = await world();
    expect(await overrideFeature({ businessId: "nope", feature: "x", enabled: true, reason: REASON }, w.admin("a"))).toMatchObject(
      { ok: false, code: "NOT_FOUND" },
    );
    const user = await createUser(db);
    expect(
      await overrideFeature(
        { businessId: w.businessId, feature: "x", enabled: true, reason: REASON },
        { userId: user.id, idempotencyKey: "b" },
      ),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await db.rtFeatureOverride.count()).toBe(0);
    expect(await db.rtAuditLog.count()).toBe(0);
  });
});
