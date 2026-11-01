import { describe, expect, it } from "vitest";
import { SCOPE_MODELS } from "@/server/admin/support";
import { can, PERMISSIONS, ROLE_PERMISSIONS } from "@/server/domain/permissions";
import { resolveActor } from "@/server/framework/actor";
import { ERROR_MESSAGES, type ErrorCode } from "@/server/framework/errors";
import { BRANCH_SCOPED_MODELS, BUSINESS_SCOPED_MODELS, ScopeError, scopedDb } from "@/server/framework/scoped-db";
import { ckb } from "@/messages/ckb";
import { en } from "@/messages/en";
import { ar } from "@/messages/ar";
import type { RtRole } from "@/generated/prisma/client";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff } from "../helpers/fixtures";

const { db } = useTestDb();

/** The error a promise rejects with, as text (message, code and meta), so a test can name the constraint. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return JSON.stringify(e, Object.getOwnPropertyNames(e));
  }
  throw new Error("expected the database to refuse this write");
}

const INTAKE_MODELS = ["RtIntake", "RtIntakeFile", "RtAiUsage"];

async function intake(businessId: string, filesHash = "a".repeat(64)) {
  return db.rtIntake.create({ data: { businessId, createdById: "u1", filesHash, model: "claude-sonnet-5-5" } });
}

describe("intake schema", () => {
  it("applies defaults: an uploaded purchase receipt with no usage, and no AI consent on a business", async () => {
    const { business } = await createBusinessWithStaff(db);
    expect(business).toMatchObject({ aiConsentAt: null, aiConsentVersion: null });
    const row = await intake(business.id);
    expect(row).toMatchObject({
      kind: "PURCHASE_RECEIPT",
      status: "UPLOADED",
      usageHalfUnits: 0,
      month: null,
      result: null,
      failureCode: null,
      stockDocumentId: null,
      refundedAt: null,
      version: 1,
    });
    const consented = await db.rtBusiness.update({
      where: { id: business.id },
      data: { aiConsentAt: new Date(), aiConsentVersion: 1 },
    });
    expect(consented.aiConsentVersion).toBe(1);
    for (const status of ["READING", "READ", "FAILED", "DRAFTED", "DISCARDED"] as const) {
      expect((await db.rtIntake.update({ where: { id: row.id }, data: { status } })).status).toBe(status);
    }
  });

  it("stores the bytes of a page and reads them back unchanged", async () => {
    const { business } = await createBusinessWithStaff(db);
    const row = await intake(business.id);
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01, 0x7f, 0x80, 0xfe]);
    await db.rtIntakeFile.create({
      data: { businessId: business.id, intakeId: row.id, position: 1, contentType: "image/jpeg", bytes, sha256: "b".repeat(64) },
    });
    const back = await db.rtIntakeFile.findFirstOrThrow({ where: { intakeId: row.id } });
    expect([...back.bytes]).toEqual([...bytes]);
    expect(back).toMatchObject({ position: 1, contentType: "image/jpeg", sha256: "b".repeat(64) });
    // One page per position of an intake.
    expect(
      await failure(
        db.rtIntakeFile.create({
          data: { businessId: business.id, intakeId: row.id, position: 1, contentType: "image/jpeg", bytes, sha256: "c".repeat(64) },
        }),
      ),
    ).toContain("P2002");
  });

  it("composite foreign keys keep a page in its intake's business", async () => {
    const a = await createBusinessWithStaff(db);
    const b = await createBusinessWithStaff(db);
    const mine = await intake(a.business.id);
    const page = { position: 1, contentType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]), sha256: "d".repeat(64) };
    expect(await failure(db.rtIntakeFile.create({ data: { ...page, businessId: b.business.id, intakeId: mine.id } }))).toContain(
      "RtIntakeFile_businessId_intakeId_fkey",
    );
    await db.rtIntakeFile.create({ data: { ...page, businessId: a.business.id, intakeId: mine.id } });
  });

  it("counts are never negative, positions start at 1 and months are YYYY-MM", async () => {
    const { business } = await createBusinessWithStaff(db);
    const row = await intake(business.id);
    expect(await failure(db.rtIntake.update({ where: { id: row.id }, data: { usageHalfUnits: -1 } }))).toContain(
      "RtIntake_usage_half_units_nonneg",
    );
    expect(await failure(db.rtIntake.update({ where: { id: row.id }, data: { month: "2026-13" } }))).toContain(
      "RtIntake_month_format",
    );
    expect((await db.rtIntake.update({ where: { id: row.id }, data: { month: "2026-10", usageHalfUnits: 2 } })).month).toBe(
      "2026-10",
    );
    const page = { businessId: business.id, intakeId: row.id, contentType: "image/jpeg", bytes: new Uint8Array([1]), sha256: "e".repeat(64) };
    expect(await failure(db.rtIntakeFile.create({ data: { ...page, position: 0 } }))).toContain("RtIntakeFile_position_positive");
    expect(await failure(db.rtAiUsage.create({ data: { businessId: business.id, month: "2026-10", halfUnits: -1 } }))).toContain(
      "RtAiUsage_half_units_nonneg",
    );
    expect(await failure(db.rtAiUsage.create({ data: { businessId: business.id, month: "10-2026" } }))).toContain(
      "RtAiUsage_month_format",
    );
  });

  it("one usage row per business and month", async () => {
    const a = await createBusinessWithStaff(db);
    const b = await createBusinessWithStaff(db);
    const usage = await db.rtAiUsage.create({ data: { businessId: a.business.id, month: "2026-10" } });
    expect(usage.halfUnits).toBe(0);
    expect(await failure(db.rtAiUsage.create({ data: { businessId: a.business.id, month: "2026-10", halfUnits: 2 } }))).toContain(
      "P2002",
    );
    await db.rtAiUsage.create({ data: { businessId: a.business.id, month: "2026-11" } });
    await db.rtAiUsage.create({ data: { businessId: b.business.id, month: "2026-10" } });
    const found = await db.rtAiUsage.findUniqueOrThrow({
      where: { businessId_month: { businessId: a.business.id, month: "2026-10" } },
    });
    expect(found.id).toBe(usage.id);
  });

  it("finds earlier intakes of a business by files hash", async () => {
    const { business } = await createBusinessWithStaff(db);
    const first = await intake(business.id, "f".repeat(64));
    await intake(business.id, "f".repeat(64));
    const found = await db.rtIntake.findMany({ where: { businessId: business.id, filesHash: "f".repeat(64) }, orderBy: { createdAt: "asc" } });
    expect(found).toHaveLength(2);
    expect(found[0]!.id).toBe(first.id);
  });

  it("the new models are business-scoped, not branch-scoped, and in no support scope", () => {
    expect(BUSINESS_SCOPED_MODELS).toEqual(expect.arrayContaining(INTAKE_MODELS));
    for (const m of INTAKE_MODELS) expect(BRANCH_SCOPED_MODELS).not.toContain(m);
    // Default deny: no support grant reads an intake, its page bytes or the AI usage counter.
    for (const models of Object.values(SCOPE_MODELS)) {
      for (const m of INTAKE_MODELS) expect(models).not.toContain(m);
    }
  });

  it("the scoped client never shows or writes another business's intake rows", async () => {
    const a = await createBusinessWithStaff(db);
    const b = await createBusinessWithStaff(db, { staff: [{ key: "owner", role: "OWNER" }] });
    const theirs = await intake(a.business.id);
    await db.rtIntakeFile.create({
      data: { businessId: a.business.id, intakeId: theirs.id, position: 1, contentType: "image/jpeg", bytes: new Uint8Array([9]), sha256: "9".repeat(64) },
    });
    await db.rtAiUsage.create({ data: { businessId: a.business.id, month: "2026-10", halfUnits: 4 } });

    const other = await resolveActor(b.staff.owner!.user.id, b.business.id);
    const s = scopedDb(other);
    expect(await s.rtIntake.findMany()).toEqual([]);
    expect(await s.rtIntake.findFirst({ where: { id: theirs.id } })).toBeNull();
    expect(await s.rtIntakeFile.findMany()).toEqual([]);
    expect(await s.rtAiUsage.findMany()).toEqual([]);
    expect((await s.rtIntake.updateMany({ where: { id: theirs.id }, data: { status: "DISCARDED" } })).count).toBe(0);
    await expect(
      s.rtIntake.create({ data: { businessId: a.business.id, createdById: "u1", filesHash: "0".repeat(64), model: "m" } }),
    ).rejects.toMatchObject({ name: "ScopeError", code: "FOREIGN_BUSINESS" });
    await expect(s.rtAiUsage.create({ data: { businessId: a.business.id, month: "2026-10" } })).rejects.toBeInstanceOf(ScopeError);
    expect((await db.rtIntake.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe("UPLOADED");
  });

  it("ai.consent belongs to the owner alone", () => {
    expect(PERMISSIONS).toContain("ai.consent");
    const roles = Object.keys(ROLE_PERMISSIONS) as RtRole[];
    expect(roles.filter((r) => can(r, "ai.consent"))).toEqual(["OWNER"]);
  });

  it("every new error code has a message in Arabic, Kurdish and English", () => {
    const codes: ErrorCode[] = [
      "AI_CONSENT_REQUIRED",
      "AI_QUOTA_EXCEEDED",
      "AI_UNAVAILABLE",
      "AI_BAD_OUTPUT",
      "INTAKE_NOT_READABLE",
      "INTAKE_UNRESOLVED",
      "DUPLICATE_RECEIPT",
      "AI_DISABLED",
    ];
    for (const code of codes) {
      for (const messages of [ERROR_MESSAGES, ar.errors, ckb.errors, en.errors]) {
        expect(typeof messages[code], code).toBe("string");
        expect(messages[code].trim().length, code).toBeGreaterThan(10);
      }
    }
  });
});
