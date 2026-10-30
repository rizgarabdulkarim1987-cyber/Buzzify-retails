import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RtRole } from "@/generated/prisma/client";
import type { ActionMeta } from "@/server/framework/action";
import { AI_INTAKE_FEATURE } from "@/server/framework/features";
import { CONSENT_VERSION } from "@/server/intake/consent";
import { FAKE_DEFAULT_RECEIPT } from "@/server/intake/provider-fake";
import { createIntake, runIntakeRead } from "@/server/intake/receipts";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan, createPlatformAdmin } from "../helpers/fixtures";

/*
 * The receipt-photo Route Handlers (the page image and the reading screen's status check), run
 * against the real intake service: only the session (metaFor) is stood in for.
 */

const session = vi.hoisted(() => ({ meta: null as ActionMeta | null }));
vi.mock("@/app/retail/catalog/_lib/call", () => ({ metaFor: async () => session.meta }));

const { GET: imageGet, HEAD: imageHead } = await import("../../src/app/retail/stock/receive/photo/[intakeId]/image/[position]/route");
const { GET: statusGet } = await import("../../src/app/retail/stock/receive/photo/[intakeId]/status/route");

const { db } = useTestDb();
const DAY = 86_400_000;

afterEach(() => {
  globalThis.__intakeFake = undefined;
  session.meta = null;
});

const jpeg = () => {
  const b = new Uint8Array(64);
  b.set(randomBytes(64));
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return b;
};

/** An active business with the AI switch on, consent, a plan with reads, and one staff member per role. */
async function shop() {
  const roles: RtRole[] = ["OWNER", "MANAGER", "ACCOUNTANT"];
  const w = await createBusinessWithStaff(db, { branches: ["Main"], staff: roles.map((r) => ({ key: r, role: r })) });
  const businessId = w.business.id;
  await db.rtBusiness.update({
    where: { id: businessId },
    data: { status: "ACTIVE", timezone: "Asia/Baghdad", enabledCurrencies: ["IQD", "USD"], defaultCurrency: "IQD", aiConsentAt: new Date(), aiConsentVersion: CONSENT_VERSION },
  });
  const code = `plan-${businessId}`;
  const plan = await createPlan(db, { code });
  await db.rtPlan.update({ where: { id: plan.id }, data: { aiMonthly: 100 } });
  await db.rtSubscription.create({
    data: { businessId, planCode: code, status: "ACTIVE", currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 30 * DAY) },
  });
  await db.rtLocation.create({ data: { businessId, branchId: w.branches.Main!.id, name: "المخزن الرئيسي" } });
  const admin = await createPlatformAdmin(db);
  await db.rtFeatureOverride.create({ data: { businessId, feature: AI_INTAKE_FEATURE, enabled: true, reason: "تفعيل للاختبار من الدعم", grantedById: admin.id } });
  const as = (role: RtRole = "OWNER"): ActionMeta => ({ userId: w.staff[role]!.user.id, businessId, idempotencyKey: randomUUID() });
  return { businessId, as };
}

/** A receipt the owner uploaded and had read (prices included). */
async function readIntake(s: Awaited<ReturnType<typeof shop>>) {
  globalThis.__intakeFake = FAKE_DEFAULT_RECEIPT;
  const made = await createIntake({ files: [{ contentType: "image/jpeg", bytes: jpeg() }] }, s.as());
  if (!made.ok) throw new Error(made.code);
  const read = await runIntakeRead({ intakeId: made.value.intakeId }, s.as());
  if (!read.ok) throw new Error(read.code);
  return made.value.intakeId;
}

const image = (intakeId: string, position = "1", head = false) =>
  (head ? imageHead : imageGet)(new Request(`http://x/retail/stock/receive/photo/${intakeId}/image/${position}`, head ? { method: "HEAD" } : {}), {
    params: Promise.resolve({ intakeId, position }),
  });
const status = (intakeId: string) => statusGet(new Request(`http://x/retail/stock/receive/photo/${intakeId}/status`), { params: Promise.resolve({ intakeId }) });

describe("the page image route", () => {
  it("serves the page with no cache anywhere, sandboxed and never sniffed", async () => {
    const s = await shop();
    const intakeId = await readIntake(s);
    session.meta = s.as();
    const res = await image(intakeId);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await res.arrayBuffer()).byteLength).toBe(64);

    // HEAD answers the same headers without the bytes (the viewer asks it to tell a PDF page apart).
    const head = await image(intakeId, "1", true);
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("image/jpeg");
    expect(head.headers.get("Cache-Control")).toBe("private, no-store");
    expect(head.body).toBeNull();
  });

  it("serves a PDF page without the sandbox (Chrome's PDF viewer needs scripts), still never cached or sniffed", async () => {
    const s = await shop();
    const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
    const made = await createIntake({ files: [{ contentType: "image/jpeg", bytes: jpeg() }, { contentType: "application/pdf", bytes: pdf }] }, s.as());
    if (!made.ok) throw new Error(made.code);
    session.meta = s.as();
    for (const head of [false, true]) {
      const res = await image(made.value.intakeId, "2", head);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/pdf");
      expect(res.headers.get("Content-Security-Policy")).toBeNull();
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Content-Disposition")).toBe(`inline; filename="receipt-page-2.pdf"`);
    }
    // The image page beside it stays sandboxed.
    expect((await image(made.value.intakeId, "1")).headers.get("Content-Security-Policy")).toBe("sandbox");
  });

  it("refuses without cost.view, without a session, for another business or a colleague's receipt; refusals are not cached either", async () => {
    const a = await shop();
    const b = await shop();
    const intakeId = await readIntake(a);

    session.meta = a.as("MANAGER"); // no cost.view
    const noCost = await image(intakeId);
    expect(noCost.status).toBe(403);
    expect(noCost.headers.get("Cache-Control")).toBe("private, no-store");

    session.meta = null; // no session
    expect((await image(intakeId)).status).toBe(403);

    session.meta = b.as(); // another business
    expect((await image(intakeId)).status).toBe(404);

    session.meta = a.as("ACCOUNTANT"); // cost.view, but not the creator and no stock.adjust
    expect((await image(intakeId)).status).toBe(404);

    session.meta = a.as();
    expect((await image(intakeId, "2")).status).toBe(404); // no such page
    expect((await image(intakeId, "7")).status).toBe(404);
    expect((await image("bad id!")).status).toBe(404);
  });
});

describe("the status route", () => {
  it("answers the status and failure code only, never cached", async () => {
    const s = await shop();
    const intakeId = await readIntake(s);
    session.meta = s.as();
    const res = await status(intakeId);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["failureCode", "ok", "status"]);
    expect(body).toEqual({ ok: true, status: "READ", failureCode: null });
  });

  it("refuses without cost.view (403) and for another business's receipt (404)", async () => {
    const a = await shop();
    const b = await shop();
    const intakeId = await readIntake(a);

    session.meta = a.as("MANAGER");
    const noCost = await status(intakeId);
    expect(noCost.status).toBe(403);
    expect(noCost.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await noCost.json()).toEqual({ ok: false, code: "FORBIDDEN" });

    session.meta = b.as();
    const other = await status(intakeId);
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ ok: false, code: "NOT_FOUND" });

    session.meta = a.as("ACCOUNTANT");
    expect((await status(intakeId)).status).toBe(404);

    session.meta = null;
    expect((await status(intakeId)).status).toBe(403);
  });
});
