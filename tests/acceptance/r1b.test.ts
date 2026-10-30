import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RtRole } from "@/generated/prisma/client";
import { overrideFeature } from "@/server/admin/lifecycle";
import { createProduct } from "@/server/catalog/products";
import { actionInfoOf, type ActionMeta } from "@/server/framework/action";
import { AI_INTAKE_FEATURE } from "@/server/framework/features";
import { gateOf } from "@/server/framework/gate";
import { lookupBarcode, readBarcodeFromImage } from "@/server/intake/barcode";
import { grantAiConsent, revokeAiConsent } from "@/server/intake/consent";
import { AiUnavailableError, getIntakeProvider, type ExtractedLine, type ExtractedReceipt } from "@/server/intake/provider";
import { getAiStatus } from "@/server/intake/quota";
import {
  acknowledgeIntakeTotal,
  createDraftFromIntake,
  createIntake,
  createIntakeItems,
  getIntake,
  getIntakeImage,
  listIntakes,
  resolveIntakeLine,
  runIntakeRead,
  setIntakeCurrency,
} from "@/server/intake/receipts";
import { getStockDocument, postStockDocument, saveStockDraft } from "@/server/stock/documents";
import { rebuildBalances } from "@/server/stock/ledger";
import { listStock } from "@/server/stock/queries";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan, createPlatformAdmin } from "../helpers/fixtures";

/*
 * R1b acceptance (spec 2026-10-30-retail-r1b-ai-intake): the AI receipt intake and the barcode
 * lookup through the real actions against the real database, with the fake provider standing in
 * for the model (NODE_ENV=test selects it; globalThis.__intakeFake sets what it "reads"). Rows that
 * no action creates (plan quota, platform admin, businesses with staff, subscription, location)
 * come from the shared fixtures, as in the R0-R2 acceptance tests. The master switch goes through
 * the platform action, consent through the owner's actions.
 *
 * A 20-line supplier receipt (known items by barcode and by name, new items, a wrong check digit,
 * a low-confidence line, a delivery charge) is read, settled, its new items created, drafted and
 * posted through R2's posting action; then a USD receipt the same way (R2 asks for the rate before
 * posting). Stock, weighted averages and the rebuilt ledger agree; each read takes 2 half units
 * once. Every refusal (no cost.view, no consent, switch off, READ_ONLY, another business) leaves
 * nothing behind.
 */

const { db } = useTestDb();

const DAY = 86_400_000;
const U = 1000n; // one base unit (quantities are base units x 1000)
const key = () => randomUUID();

afterEach(() => {
  globalThis.__intakeFake = undefined;
});

/** A valid EAN-13 for the first 12 digits. */
function ean13(first12: string): string {
  const sum = [...first12].reduce((n, d, i) => n + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + String((10 - (sum % 10)) % 10);
}
/** The same code with a wrong check digit. */
const badCheck = (code: string) => code.slice(0, -1) + String((Number(code.at(-1)) + 1) % 10);

/** A valid EAN-13 no shop in these tests owns (the e2e seed gives it to its known item). */
const NEW_CODE = "6291041500213";

/** A minimal JPEG-looking page (magic number + random body, so every call is a different image). */
function jpeg(size = 256) {
  const b = new Uint8Array(size);
  b.set(randomBytes(size));
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return b;
}
const page = (bytes = jpeg()) => ({ contentType: "image/jpeg", bytes });

function ok<T>(r: { ok: true; value: T } | { ok: false; code: string; details?: unknown }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code} ${JSON.stringify(r.details ?? {})}`);
  return r.value;
}

// ---------------------------------------------------------------------------------------------
// The world

const ROLES: RtRole[] = ["OWNER", "MANAGER", "STOCK", "PURCHASING", "ACCOUNTANT", "CASHIER"];

/** The known items of a shop: a piece (base) and a carton of 12, each with its own barcode. */
const KNOWN = [
  "زيت دوار الشمس ١ لتر",
  "رز بسمتي ٥ كغم",
  "سكر أبيض ٢ كغم",
  "طحين أبيض ١ كغم",
  "معجون طماطم ٤٠٠ غرام",
  "حليب مجفف ٩٠٠ غرام",
  "شاي أسود ٤٥٠ غرام",
  "عدس أحمر ١ كغم",
  "فاصوليا بيضاء ٥٠٠ غرام",
  "تونة معلبة ١٦٠ غرام",
] as const;

const pieceCode = (i: number) => ean13(`6291041${String(i).padStart(2, "0")}001`);
const cartonCode = (i: number) => ean13(`6291041${String(i).padStart(2, "0")}002`);

async function business(label: string, admin: { id: string }) {
  const w = await createBusinessWithStaff(db, { branches: ["Main"], staff: ROLES.map((r) => ({ key: r, role: r })) });
  const businessId = w.business.id;
  await db.rtBusiness.update({
    where: { id: businessId },
    data: { status: "ACTIVE", name: label, timezone: "Asia/Baghdad", defaultCurrency: "IQD", enabledCurrencies: ["IQD", "USD"] },
  });
  // The plan's quota: 10 reads a month = 20 half units (no action sets plans yet).
  const code = `plan-${businessId}`;
  await createPlan(db, { code });
  await db.rtPlan.update({ where: { code }, data: { aiMonthly: 10 } });
  const subscription = await db.rtSubscription.create({
    data: { businessId, planCode: code, status: "ACTIVE", currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 30 * DAY) },
  });
  const location = await db.rtLocation.create({ data: { businessId, branchId: w.branches.Main!.id, name: "المخزن الرئيسي" } });
  const as = (role: RtRole = "OWNER", k = key()): ActionMeta => ({ userId: w.staff[role]!.user.id, businessId, idempotencyKey: k });
  const setSwitch = async (enabled: boolean) =>
    ok(
      await overrideFeature(
        { businessId, feature: AI_INTAKE_FEATURE, enabled, reason: enabled ? "تفعيل القراءة بطلب المالك" : "إيقاف القراءة مؤقتاً" },
        { userId: admin.id, idempotencyKey: key() },
      ),
    );

  // The platform admin turns the switch on, the owner consents (both through their actions).
  await setSwitch(true);
  ok(await grantAiConsent({}, as("OWNER")));

  // The catalog: ten known items through R1's action.
  const items: { variantId: string; piece: string; carton: string }[] = [];
  for (const [i, nameAr] of KNOWN.entries()) {
    const made = ok(
      await createProduct(
        {
          nameAr,
          baseUnit: { name: "قطعة", barcodes: [pieceCode(i + 1)] },
          extraUnits: [{ name: "كرتون", factor: 12, barcodes: [cartonCode(i + 1)] }],
          price: { currency: "IQD", amountMinor: 2000n },
        },
        as("OWNER"),
      ),
    );
    const carton = await db.rtUnit.findFirstOrThrow({ where: { variantId: made.variantId, factor: 12 } });
    items.push({ variantId: made.variantId, piece: made.baseUnitId, carton: carton.id });
  }

  const usage = async () => (await db.rtAiUsage.findMany({ where: { businessId } })).reduce((n, r) => n + r.halfUnits, 0);
  const counts = async () => ({
    intakes: await db.rtIntake.count({ where: { businessId } }),
    files: await db.rtIntakeFile.count({ where: { businessId } }),
    documents: await db.rtStockDocument.count({ where: { businessId } }),
    movements: await db.rtStockMovement.count({ where: { businessId } }),
    products: await db.rtProduct.count({ where: { businessId } }),
    usage: await usage(),
  });
  return { ...w, businessId, subscription, location, as, setSwitch, items, usage, counts };
}
type Shop = Awaited<ReturnType<typeof business>>;

async function world() {
  const admin = await createPlatformAdmin(db);
  return { admin, a: await business("سوق أ", admin), b: await business("سوق ب", admin) };
}

/** Stored balances equal the movements rebuilt; nothing below zero. */
async function ledgerHolds(s: Shop, step: string) {
  const { mismatches } = await db.$transaction((tx) => rebuildBalances(tx, s.businessId, { fix: false }));
  expect(mismatches, step).toEqual([]);
  expect(await db.rtStockBalance.count({ where: { businessId: s.businessId, qty: { lt: 0n } } }), step).toBe(0);
}

async function totals(s: Shop, variantId: string) {
  const r = await db.rtStockBalance.aggregate({ where: { businessId: s.businessId, variantId }, _sum: { qty: true, valueMinor: true } });
  return { qty: r._sum.qty ?? 0n, valueMinor: r._sum.valueMinor ?? 0n };
}

/** Uploads one page and reads it with `scenario` as the provider's answer. */
async function readReceipt(s: Shop, scenario: ExtractedReceipt, role: RtRole = "OWNER") {
  globalThis.__intakeFake = scenario;
  const { intakeId } = ok(await createIntake({ files: [page()] }, s.as(role)));
  const read = await runIntakeRead({ intakeId }, s.as(role));
  return { intakeId, read };
}

const view = async (s: Shop, intakeId: string) => ok(await getIntake({ intakeId }, s.as("OWNER")));

// ---------------------------------------------------------------------------------------------
// The 20-line receipt

type Plan =
  | { known: number; unit: "piece" | "carton"; settle?: "unit" }
  | { create: true }
  | { discard: true };

type Row = ExtractedLine & { plan: Plan; expectStatus: "MATCHED" | "SUGGESTED" | "DOUBTFUL" | "UNKNOWN" };

const line = (
  description: string,
  quantity: string,
  unitPrice: string,
  lineTotal: string,
  plan: Plan,
  expectStatus: Row["expectStatus"],
  extra: Partial<ExtractedLine> = {},
): Row => ({ description, quantity, unitPrice, lineTotal, confidence: 0.95, ...extra, plan, expectStatus });

const RECEIPT_ROWS: Row[] = [
  // Known items by their printed barcode (the barcode's unit when no unit is written).
  line(KNOWN[0], "2", "13200", "26400", { known: 1, unit: "carton" }, "MATCHED", { barcode: cartonCode(1) }),
  line(KNOWN[1], "10", "1500", "15000", { known: 2, unit: "piece" }, "MATCHED", { barcode: pieceCode(2) }),
  line(KNOWN[2], "1", "18000", "18000", { known: 3, unit: "carton" }, "MATCHED", { barcode: cartonCode(3) }),
  // Arabic-Indic digits are the same numbers.
  line(KNOWN[3], "٢٤", "٧٥٠", "١٨٠٠٠", { known: 4, unit: "piece" }, "MATCHED", { barcode: pieceCode(4) }),
  // A written unit must name one of the item's units.
  line(KNOWN[4], "8", "1250", "10000", { known: 5, unit: "piece" }, "MATCHED", { barcode: pieceCode(5), unitText: "قطعة" }),
  line(KNOWN[5], "3", "30000", "90000", { known: 6, unit: "carton" }, "MATCHED", { barcode: cartonCode(6) }),
  // Read with low confidence: doubtful until the reviewer confirms.
  line(KNOWN[6], "6", "4250", "25500", { known: 7, unit: "piece", settle: "unit" }, "DOUBTFUL", { barcode: pieceCode(7), confidence: 0.5 }),
  line(KNOWN[7], "1", "15000", "15000", { known: 8, unit: "carton" }, "MATCHED", { barcode: cartonCode(8) }),
  // Known items by name only: suggestions until confirmed.
  line(KNOWN[8], "12", "1000", "12000", { known: 9, unit: "piece", settle: "unit" }, "SUGGESTED", { unitText: "قطعة" }),
  line(KNOWN[9], "2", "24000", "48000", { known: 10, unit: "carton", settle: "unit" }, "SUGGESTED", { unitText: "كرتون" }),
  // New items, created from the receipt in one call.
  line("منظف أرضيات ليمون ٣ لتر", "4", "3500", "14000", { create: true }, "UNKNOWN", { unitText: "قطعة" }),
  line("مناديل ورقية ٢٠٠ منديل", "10", "1250", "12500", { create: true }, "UNKNOWN", { unitText: "كيس" }),
  line("صابون يدين سائل ٥٠٠ مل", "6", "2000", "12000", { create: true }, "UNKNOWN"),
  line("معكرونة سباغيتي ٥٠٠ غرام", "20", "750", "15000", { create: true }, "UNKNOWN", { unitText: "قطعة" }),
  line("ملح طعام مكرر ١ كغم", "10", "500", "5000", { create: true }, "UNKNOWN", { unitText: "قطعة" }),
  line("بسكويت بالتمر ١٢ قطعة", "8", "2250", "18000", { create: true }, "UNKNOWN", { unitText: "علبة" }),
  line("قهوة عربية بالهيل ٢٥٠ غرام", "5", "6000", "30000", { create: true }, "UNKNOWN", { unitText: "قطعة" }),
  line("ماء معدني ٦ قناني", "12", "1500", "18000", { create: true }, "UNKNOWN", { unitText: "قطعة" }),
  // A known item whose printed barcode has a wrong check digit: the code is not used, the name is.
  line(KNOWN[2], "5", "1600", "8000", { known: 3, unit: "piece", settle: "unit" }, "SUGGESTED", { barcode: badCheck(cartonCode(3)), unitText: "قطعة" }),
  // Not goods: discarded by the reviewer.
  line("أجور نقل وتحميل", "1", "5000", "5000", { discard: true }, "UNKNOWN"),
];

function strip(row: Row): ExtractedLine {
  const l: Partial<Row> = { ...row };
  delete l.plan;
  delete l.expectStatus;
  return l as ExtractedLine;
}
const plainNumber = (text: string) => Number(text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)));

const RECEIPT: ExtractedReceipt = {
  supplier: "شركة الرافدين للمواد الغذائية",
  date: "2026-10-29",
  currency: "د.ع",
  receiptNo: "4521",
  total: String(RECEIPT_ROWS.reduce((n, r) => n + plainNumber(r.lineTotal!), 0)),
  lines: RECEIPT_ROWS.map(strip),
};

describe("R1b acceptance: a supplier's receipt from a photo to the stock", () => {
  it("20 lines (known, new, IQD) and then a USD receipt: read, settled, drafted and posted; stock, averages and ledger exact; each read counted once", async () => {
    const { a } = await world();
    expect(RECEIPT.lines).toHaveLength(20);
    const K = (n: number) => a.items[n - 1]!;

    // Stock already on hand of the first item: 12 pieces at 1,000 through R2's own receipt.
    const before = ok(await saveStockDraft({ kind: "RECEIPT", lines: [{ variantId: K(1).variantId, unitId: K(1).piece, quantity: "12", cost: { amount: "1000", currency: "IQD" } }] }, a.as()));
    ok(await postStockDocument({ documentId: before.documentId, expectedVersion: before.version }, a.as()));
    expect(await totals(a, K(1).variantId)).toEqual({ qty: 12n * U, valueMinor: 12_000n });
    await ledgerHolds(a, "before the intake");

    // 1. Upload: one read reserved (2 half units); a retry with the same key replays it.
    globalThis.__intakeFake = RECEIPT;
    const uploadKey = key();
    const bytes = jpeg(2048);
    const created = ok(await createIntake({ files: [page(bytes)] }, a.as("OWNER", uploadKey)));
    expect(created.duplicateOf).toBeUndefined();
    expect(await a.usage()).toBe(2);
    expect(ok(await createIntake({ files: [page(bytes)] }, a.as("OWNER", uploadKey)))).toEqual(created);
    expect(await a.usage()).toBe(2);
    const { intakeId } = created;

    // 2. Read. Reading again (another key) does not call or charge again.
    const readKey = key();
    expect(ok(await runIntakeRead({ intakeId }, a.as("OWNER", readKey)))).toEqual({ intakeId, status: "READ" });
    expect(ok(await runIntakeRead({ intakeId }, a.as("OWNER")))).toEqual({ intakeId, status: "READ" });
    expect(ok(await runIntakeRead({ intakeId }, a.as("OWNER", readKey)))).toEqual({ intakeId, status: "READ" });
    expect(await a.usage()).toBe(2);
    // The stored page is served back to the reviewer as uploaded.
    expect(ok(await getIntakeImage({ intakeId, position: 1 }, a.as()))).toEqual({ contentType: "image/jpeg", bytes });

    let v = await view(a, intakeId);
    expect(v).toMatchObject({ status: "READ", pageCount: 1, duplicateOf: null, stockDocumentId: null });
    expect(v.result).toMatchObject({ supplier: RECEIPT.supplier, receiptNo: "4521", receiptCurrency: "IQD", totalCheck: { ok: true } });
    const lines = v.result!.lines;
    expect(lines.map((l) => l.status)).toEqual(RECEIPT_ROWS.map((r) => r.expectStatus));
    for (const [i, r] of RECEIPT_ROWS.entries()) {
      if ("known" in r.plan) expect(lines[i]!.variantId, `line ${i + 1}`).toBe(K(r.plan.known).variantId);
      else expect(lines[i]!.variantId, `line ${i + 1}`).toBeUndefined();
    }
    expect(lines[0]).toMatchObject({ unitId: K(1).carton, source: "BARCODE", resolved: true });
    expect(lines[3]).toMatchObject({ quantity: "٢٤", unitPrice: "٧٥٠", unitId: K(4).piece });
    expect(lines[6]!.reasons).toContain("LOW_CONFIDENCE");
    expect(lines[8]).toMatchObject({ source: "NAME", unitId: K(9).piece, resolved: false });
    expect(lines[18]!.reasons).toContain("BARCODE_CHECKSUM");
    expect(lines[18]).toMatchObject({ source: "NAME", barcode: badCheck(cartonCode(3)) });
    expect(await listIntakes({}, a.as())).toMatchObject({ ok: true, value: { rows: [{ id: intakeId, status: "READ", supplier: RECEIPT.supplier, lineCount: 20 }] } });

    // Nothing open may go to a draft yet.
    expect(await createDraftFromIntake({ intakeId, expectedVersion: v.version }, a.as())).toMatchObject({ ok: false, code: "INTAKE_UNRESOLVED" });

    // 3. Settle: the new items in one call (catalog.manage and cost.view: the owner here) ...
    const newLines = RECEIPT_ROWS.flatMap((r, i) => ("create" in r.plan ? [i + 1] : []));
    expect(newLines).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);
    const productsBefore = await db.rtProduct.count({ where: { businessId: a.businessId } });
    expect(await createIntakeItems({ intakeId, lineNos: newLines, expectedVersion: v.version }, a.as("MANAGER"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    let version = ok(await createIntakeItems({ intakeId, lineNos: newLines, expectedVersion: v.version }, a.as())).version;
    expect(await db.rtProduct.count({ where: { businessId: a.businessId } })).toBe(productsBefore + 8);
    // ... the reviewer's confirmations ...
    for (const [i, r] of RECEIPT_ROWS.entries()) {
      if (!("known" in r.plan) || r.plan.settle !== "unit") continue;
      const item = K(r.plan.known);
      version = ok(await resolveIntakeLine({ intakeId, lineNo: i + 1, action: { kind: "PICK_UNIT", unitId: item[r.plan.unit] }, expectedVersion: version }, a.as())).version;
    }
    // ... and the delivery charge discarded.
    version = ok(await resolveIntakeLine({ intakeId, lineNo: 20, action: { kind: "DISCARD" }, expectedVersion: version }, a.as())).version;

    v = await view(a, intakeId);
    expect(v.version).toBe(version);
    const settled = v.result!.lines;
    expect(settled.filter((l) => !l.discarded).every((l) => l.status === "MATCHED" && l.resolved)).toBe(true);
    expect(settled[19]).toMatchObject({ discarded: true });
    // The new items carry the receipt's names and units (no unit written: a piece).
    const nameOf = async (lineNo: number) => (await db.rtVariant.findUniqueOrThrow({ where: { id: settled[lineNo - 1]!.variantId! }, select: { product: { select: { nameAr: true } } } })).product.nameAr;
    for (const n of newLines) expect(await nameOf(n)).toBe(RECEIPT_ROWS[n - 1]!.description);
    expect(new Set(newLines.map((n) => settled[n - 1]!.variantId)).size).toBe(8);
    const unitOf = async (lineNo: number) => (await db.rtUnit.findUniqueOrThrow({ where: { id: settled[lineNo - 1]!.unitId! } })).name;
    expect([await unitOf(11), await unitOf(12), await unitOf(13), await unitOf(16)]).toEqual(["قطعة", "كيس", "قطعة", "علبة"]);

    // 4. The draft: 19 lines, nothing in stock yet, the quota untouched.
    const { documentId } = ok(await createDraftFromIntake({ intakeId, expectedVersion: version }, a.as()));
    const draft = ok(await getStockDocument({ documentId }, a.as()));
    expect(draft).toMatchObject({ kind: "RECEIPT", status: "DRAFT", locationId: a.location.id });
    expect(draft.supplierRef).toBe("شركة الرافدين للمواد الغذائية · #4521 · 2026-10-29");
    expect(draft.lines).toHaveLength(19);
    expect(draft.lines.every((l) => l.currency === "IQD" && !l.costMissing)).toBe(true);
    expect(await view(a, intakeId)).toMatchObject({ status: "DRAFTED", stockDocumentId: documentId });
    expect(await totals(a, K(1).variantId)).toEqual({ qty: 12n * U, valueMinor: 12_000n });
    expect(await a.usage()).toBe(2);
    // Drafting again returns the same draft.
    expect(ok(await createDraftFromIntake({ intakeId, expectedVersion: (await view(a, intakeId)).version }, a.as()))).toEqual({ documentId });

    // 5. Posted through R2's posting action, as the receipt screen does.
    ok(await postStockDocument({ documentId, expectedVersion: draft.version }, a.as()));
    await ledgerHolds(a, "after posting the intake draft");

    // Every kept line reached the stock of its item, at its printed price.
    const expected = new Map<string, { qty: bigint; valueMinor: bigint }>();
    for (const [i, r] of RECEIPT_ROWS.entries()) {
      if ("discard" in r.plan) continue;
      const l = settled[i]!;
      const factor = "known" in r.plan && r.plan.unit === "carton" ? 12n : 1n;
      const qty = BigInt(plainNumber(r.quantity));
      const e = expected.get(l.variantId!) ?? { qty: 0n, valueMinor: 0n };
      expected.set(l.variantId!, { qty: e.qty + qty * factor * U, valueMinor: e.valueMinor + qty * BigInt(plainNumber(r.unitPrice!)) });
    }
    expected.set(K(1).variantId, { qty: expected.get(K(1).variantId)!.qty + 12n * U, valueMinor: expected.get(K(1).variantId)!.valueMinor + 12_000n });
    expect(expected.size).toBe(18); // 10 known items (the third twice) + 8 new
    for (const [variantId, want] of expected) expect(await totals(a, variantId), variantId).toEqual(want);
    // Weighted averages: (12,000 + 2 x 13,200) / 36 = 1,066.7 -> 1,067; (18,000 + 5 x 1,600) / 17 = 1,529.4 -> 1,529.
    expect(await totals(a, K(1).variantId)).toEqual({ qty: 36n * U, valueMinor: 38_400n });
    expect(ok(await listStock({ query: pieceCode(1) }, a.as())).rows[0]).toMatchObject({ variantId: K(1).variantId, qty: 36n * U, valueMinor: 38_400n, avgUnitCostMinor: 1_067n });
    expect(ok(await listStock({ query: pieceCode(3) }, a.as())).rows[0]).toMatchObject({ qty: 17n * U, valueMinor: 26_000n, avgUnitCostMinor: 1_529n });
    // The intake keeps its draft; the read is still counted once.
    expect(await view(a, intakeId)).toMatchObject({ status: "DRAFTED", stockDocumentId: documentId });
    expect(await db.rtIntake.findUniqueOrThrow({ where: { id: intakeId } })).toMatchObject({ usageHalfUnits: 2, refundedAt: null });
    expect(await a.usage()).toBe(2);

    // 6. A receipt printed in USD: the oil (by barcode) and the new pasta (now known by name).
    const pastaLine = settled[13]!;
    const usd = await readReceipt(a, {
      supplier: "Al-Noor Trading",
      currency: "USD",
      total: "19.00",
      lines: [
        { description: KNOWN[0], barcode: cartonCode(1), quantity: "1", unitPrice: "9.00", lineTotal: "9.00", confidence: 0.95 },
        { description: "معكرونة سباغيتي ٥٠٠ غرام", quantity: "20", unitText: "قطعة", unitPrice: "0.50", lineTotal: "10.00", confidence: 0.95 },
      ],
    });
    expect(usd.read).toMatchObject({ ok: true, value: { status: "READ" } });
    expect(await a.usage()).toBe(4);
    let u = await view(a, usd.intakeId);
    expect(u.result).toMatchObject({ receiptCurrency: "USD", totalCheck: { ok: true } });
    expect(u.result!.lines.map((l) => [l.status, l.variantId])).toEqual([
      ["MATCHED", K(1).variantId],
      ["SUGGESTED", pastaLine.variantId],
    ]);
    ok(await resolveIntakeLine({ intakeId: usd.intakeId, lineNo: 2, action: { kind: "PICK_UNIT", unitId: pastaLine.unitId! }, expectedVersion: u.version }, a.as()));
    u = await view(a, usd.intakeId);
    const usdDraft = ok(await createDraftFromIntake({ intakeId: usd.intakeId, expectedVersion: u.version }, a.as()));
    let doc = ok(await getStockDocument({ documentId: usdDraft.documentId }, a.as()));
    expect(doc.lines.map((l) => [l.currency, l.unitCostMinor, l.rateMicro])).toEqual([
      ["USD", 900n, null],
      ["USD", 50n, null],
    ]);
    // R2 asks for the rate before posting a foreign cost; the receipt screen saves it on the draft.
    expect(await postStockDocument({ documentId: doc.id, expectedVersion: doc.version }, a.as())).toMatchObject({
      ok: false,
      code: "STOCK_RULE",
      details: { lineNo: "1", reason: "RATE_REQUIRED" },
    });
    const withRate = ok(
      await saveStockDraft(
        {
          documentId: doc.id,
          expectedVersion: doc.version,
          kind: "RECEIPT",
          supplierRef: doc.supplierRef,
          lines: doc.lines.map((l) => ({ variantId: l.variantId, unitId: l.unitId, quantity: l.enteredQuantity, cost: { amount: l.unitCostMinor === 900n ? "9.00" : "0.50", currency: "USD" as const }, rate: "1500" })),
        },
        a.as(),
      ),
    );
    ok(await postStockDocument({ documentId: doc.id, expectedVersion: withRate.version }, a.as()));
    doc = ok(await getStockDocument({ documentId: doc.id }, a.as()));
    expect(doc.lines.map((l) => [l.currency, l.unitCostMinor, l.rateMicro, l.valueMinor])).toEqual([
      ["USD", 900n, 1_500_000_000n, 13_500n],
      ["USD", 50n, 1_500_000_000n, 15_000n],
    ]);
    await ledgerHolds(a, "after the USD receipt");
    // Oil: (38,400 + 13,500) / 48 = 1,081.25 -> 1,081. Pasta: (15,000 + 15,000) / 40 = 750.
    expect(ok(await listStock({ query: pieceCode(1) }, a.as())).rows[0]).toMatchObject({ qty: 48n * U, valueMinor: 51_900n, avgUnitCostMinor: 1_081n });
    expect(await totals(a, pastaLine.variantId!)).toEqual({ qty: 40n * U, valueMinor: 30_000n });
    // Two reads, two half units each, never more.
    expect(await a.usage()).toBe(4);
    expect(ok(await getAiStatus({}, a.as()))).toMatchObject({ enabled: true, consentCurrent: true, monthlyLimit: 10, limitHalfUnits: 20, usedHalfUnits: 4 });
  }, 180_000);

  it("refusals leave nothing behind: without cost.view, without consent, with the switch off, while READ_ONLY", async () => {
    const { a } = await world();
    globalThis.__intakeFake = RECEIPT;
    const read = ok(await createIntake({ files: [page()] }, a.as()));
    ok(await runIntakeRead({ intakeId: read.intakeId }, a.as()));
    const v = await view(a, read.intakeId);
    const sample = (intakeId: string) => ({
      createIntake: () => createIntake({ files: [page()] }, a.as()),
      runIntakeRead: () => runIntakeRead({ intakeId }, a.as()),
      resolve: () => resolveIntakeLine({ intakeId, lineNo: 20, action: { kind: "DISCARD" }, expectedVersion: v.version }, a.as()),
      currency: () => setIntakeCurrency({ intakeId, currency: "USD", expectedVersion: v.version }, a.as()),
      items: () => createIntakeItems({ intakeId, lineNos: [11], expectedVersion: v.version }, a.as()),
      ack: () => acknowledgeIntakeTotal({ intakeId, expectedVersion: v.version }, a.as()),
      draft: () => createDraftFromIntake({ intakeId, expectedVersion: v.version }, a.as()),
      barcodeAi: () => readBarcodeFromImage({ image: page() }, a.as()),
    });
    const calls = sample(read.intakeId);
    const start = await a.counts();
    expect(start).toMatchObject({ intakes: 1, files: 1, usage: 2 });

    // 1. Roles without cost.view (whatever else they hold) can neither upload, read nor see a receipt.
    for (const role of ["MANAGER", "PURCHASING", "STOCK", "CASHIER"] as const) {
      expect(await createIntake({ files: [page()] }, a.as(role)), role).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(await runIntakeRead({ intakeId: read.intakeId }, a.as(role)), role).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(await getIntake({ intakeId: read.intakeId }, a.as(role)), role).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(await listIntakes({}, a.as(role)), role).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(await getIntakeImage({ intakeId: read.intakeId, position: 1 }, a.as(role)), role).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(await createDraftFromIntake({ intakeId: read.intakeId, expectedVersion: v.version }, a.as(role)), role).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    // The accountant sees costs but may not use the AI.
    expect(await createIntake({ files: [page()] }, a.as("ACCOUNTANT"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await a.counts()).toEqual(start);

    // 2. Without the owner's consent: nothing uploaded, nothing reserved, nothing sent.
    const uploaded = ok(await createIntake({ files: [page()] }, a.as())); // before the consent is withdrawn
    expect(await a.usage()).toBe(4);
    ok(await revokeAiConsent({}, a.as()));
    let sent = 0;
    globalThis.__intakeFake = () => {
      sent += 1;
      return RECEIPT;
    };
    expect(await calls.createIntake()).toMatchObject({ ok: false, code: "AI_CONSENT_REQUIRED" });
    // The upload made before: its read is refused and its reservation given back.
    expect(await runIntakeRead({ intakeId: uploaded.intakeId }, a.as())).toMatchObject({ ok: false, code: "AI_CONSENT_REQUIRED" });
    expect(await a.usage()).toBe(2);
    expect(await calls.barcodeAi()).toMatchObject({ ok: false, code: "AI_CONSENT_REQUIRED" });
    expect(sent).toBe(0);
    expect(await a.counts()).toEqual({ ...start, intakes: 2, files: 2 });
    // Only the owner may consent again.
    expect(await grantAiConsent({}, a.as("MANAGER"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    ok(await grantAiConsent({}, a.as()));
    const afterConsent = await a.counts();

    // 3. The master switch off: every AI action and every read of a receipt is refused; the barcode lookup is not AI.
    await a.setSwitch(false);
    for (const [name, call] of Object.entries(calls)) expect(await call(), name).toMatchObject({ ok: false, code: "AI_DISABLED" });
    expect(await getIntake({ intakeId: read.intakeId }, a.as())).toMatchObject({ ok: false, code: "AI_DISABLED" });
    expect(await listIntakes({}, a.as())).toMatchObject({ ok: false, code: "AI_DISABLED" });
    expect(await getIntakeImage({ intakeId: read.intakeId, position: 1 }, a.as())).toMatchObject({ ok: false, code: "AI_DISABLED" });
    expect(await grantAiConsent({}, a.as())).toMatchObject({ ok: false, code: "AI_DISABLED" });
    expect(ok(await getAiStatus({}, a.as()))).toMatchObject({ enabled: false });
    expect(ok(await lookupBarcode({ code: pieceCode(1) }, a.as("CASHIER")))).toMatchObject({ status: "KNOWN", variantId: a.items[0]!.variantId });
    expect(sent).toBe(0);
    expect(await a.counts()).toEqual(afterConsent);
    // A replay of an earlier success is refused too (the switch is checked before the replay).
    await a.setSwitch(true);
    const replayKey = key();
    ok(await resolveIntakeLine({ intakeId: read.intakeId, lineNo: 20, action: { kind: "DISCARD" }, expectedVersion: v.version }, a.as("OWNER", replayKey)));
    await a.setSwitch(false);
    expect(await resolveIntakeLine({ intakeId: read.intakeId, lineNo: 20, action: { kind: "DISCARD" }, expectedVersion: v.version }, a.as("OWNER", replayKey))).toMatchObject({
      ok: false,
      code: "AI_DISABLED",
    });
    await a.setSwitch(true);

    // 4. READ_ONLY (the subscription ended past its grace): every intake write refused, reads go on.
    await db.rtSubscription.update({ where: { id: a.subscription.id }, data: { currentPeriodStart: new Date(Date.now() - 60 * DAY), currentPeriodEnd: new Date(Date.now() - 30 * DAY), graceDays: 7 } });
    expect(await gateOf(a.businessId, db)).toBe("READ_ONLY");
    const frozen = await a.counts();
    const w = await view(a, read.intakeId);
    const fresh = sample(read.intakeId);
    for (const [name, call] of Object.entries(fresh)) expect(await call(), name).toMatchObject({ ok: false, code: "READ_ONLY" });
    // Every exported write action of the intake modules, found from the modules themselves.
    const writes = intakeWriteActions();
    expect(writes.filter((x) => x.allowWhenReadOnly).map((x) => x.name)).toEqual(["ai.consent.revoke"]);
    for (const x of writes.filter((y) => !y.allowWhenReadOnly)) {
      expect(await x.call(WRITE_SAMPLES[x.name], a.as()), x.name).toMatchObject({ ok: false, code: "READ_ONLY" });
    }
    expect(sent).toBe(0);
    expect(await a.counts()).toEqual(frozen);
    expect(await view(a, read.intakeId)).toEqual(w);
    expect(ok(await listIntakes({}, a.as())).rows).toHaveLength(2);
    expect(ok(await getIntakeImage({ intakeId: read.intakeId, position: 1 }, a.as())).contentType).toBe("image/jpeg");
    expect(ok(await lookupBarcode({ code: cartonCode(2) }, a.as()))).toMatchObject({ status: "KNOWN", unitName: "كرتون" });
  }, 120_000);

  it("another business neither sees nor changes A's receipts, their images or their ids", async () => {
    const { a, b } = await world();
    globalThis.__intakeFake = RECEIPT;
    const bytes = jpeg(1024);
    const mine = ok(await createIntake({ files: [page(bytes)] }, a.as()));
    ok(await runIntakeRead({ intakeId: mine.intakeId }, a.as()));
    const before = await db.rtIntake.findUniqueOrThrow({ where: { id: mine.intakeId } });
    const id = mine.intakeId;
    const v = before.version;
    const bCounts = await b.counts();

    const notFound = { ok: false, code: "NOT_FOUND" };
    expect(await getIntake({ intakeId: id }, b.as())).toMatchObject(notFound);
    expect(await getIntakeImage({ intakeId: id, position: 1 }, b.as())).toMatchObject(notFound);
    expect(await runIntakeRead({ intakeId: id }, b.as())).toMatchObject(notFound);
    expect(await resolveIntakeLine({ intakeId: id, lineNo: 20, action: { kind: "DISCARD" }, expectedVersion: v }, b.as())).toMatchObject(notFound);
    expect(await setIntakeCurrency({ intakeId: id, currency: "USD", expectedVersion: v }, b.as())).toMatchObject(notFound);
    expect(await createIntakeItems({ intakeId: id, lineNos: [11], expectedVersion: v }, b.as())).toMatchObject(notFound);
    expect(await acknowledgeIntakeTotal({ intakeId: id, expectedVersion: v }, b.as())).toMatchObject(notFound);
    expect(await createDraftFromIntake({ intakeId: id, expectedVersion: v }, b.as())).toMatchObject(notFound);
    expect(await listIntakes({ cursor: id }, b.as())).toMatchObject(notFound);
    expect(ok(await listIntakes({}, b.as())).rows).toEqual([]);
    // B picking A's items into its own receipt: not found either.
    const theirs = ok(await createIntake({ files: [page()] }, b.as()));
    ok(await runIntakeRead({ intakeId: theirs.intakeId }, b.as()));
    const tv = await view(b, theirs.intakeId);
    expect(
      await resolveIntakeLine({ intakeId: theirs.intakeId, lineNo: 20, action: { kind: "PICK_ITEM", variantId: a.items[0]!.variantId, unitId: a.items[0]!.piece }, expectedVersion: tv.version }, b.as()),
    ).toMatchObject(notFound);
    // The same images in B are not a duplicate of A's.
    expect(ok(await createIntake({ files: [page(bytes)] }, b.as())).duplicateOf).toBeUndefined();
    // B's own receipt matched B's catalog, never A's.
    const aVariants = new Set(a.items.map((i) => i.variantId));
    expect(tv.result!.lines.some((l) => l.variantId && aVariants.has(l.variantId))).toBe(false);
    expect(tv.result!.lines[0]!.variantId).toBe(b.items[0]!.variantId);
    // A code only A has means nothing in B.
    ok(await createProduct({ nameAr: "منتج خاص بالسوق أ", baseUnit: { name: "قطعة", barcodes: [NEW_CODE] } }, a.as()));
    expect(ok(await lookupBarcode({ code: NEW_CODE }, a.as()))).toMatchObject({ status: "KNOWN" });
    expect(ok(await lookupBarcode({ code: NEW_CODE }, b.as()))).toEqual({ status: "UNKNOWN", code: NEW_CODE, checked: true });
    // B's owner acting inside A (not a member): refused before anything.
    expect(await getIntake({ intakeId: id }, { ...b.as(), businessId: a.businessId })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await createIntake({ files: [page()] }, { ...b.as(), businessId: a.businessId })).toMatchObject({ ok: false, code: "FORBIDDEN" });

    // A's receipt is as it was; A's quota is A's, B's is B's.
    expect(await db.rtIntake.findUniqueOrThrow({ where: { id } })).toEqual(before);
    expect(await a.usage()).toBe(2);
    expect(await b.counts()).toMatchObject({ intakes: bCounts.intakes + 2, usage: bCounts.usage + 4 });
  }, 120_000);

  it("barcodes: known, new and wrong check digit, typed (no AI) or read from a photo (AI, half a read each)", async () => {
    const { a } = await world();
    const oil = a.items[0]!;
    // Typed or scanned on the device: no switch, no consent, no quota; any role that sees stock.
    expect(ok(await lookupBarcode({ code: pieceCode(1) }, a.as("CASHIER")))).toMatchObject({ status: "KNOWN", variantId: oil.variantId, unitId: oil.piece, unitName: "قطعة", nameAr: KNOWN[0] });
    expect(ok(await lookupBarcode({ code: cartonCode(1) }, a.as("STOCK")))).toMatchObject({ status: "KNOWN", unitId: oil.carton, unitName: "كرتون" });
    const arabicDigits = pieceCode(1).replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
    expect(ok(await lookupBarcode({ code: arabicDigits }, a.as()))).toMatchObject({ status: "KNOWN", code: pieceCode(1) });
    expect(ok(await lookupBarcode({ code: NEW_CODE }, a.as()))).toEqual({ status: "UNKNOWN", code: NEW_CODE, checked: true });
    expect(ok(await lookupBarcode({ code: badCheck(NEW_CODE) }, a.as()))).toEqual({ status: "INVALID_CHECKSUM" });
    // No answer carries a price.
    expect(JSON.stringify(ok(await lookupBarcode({ code: pieceCode(1) }, a.as())), (_k, x) => (typeof x === "bigint" ? x.toString() : x))).not.toMatch(/Minor|price|cost/i);
    expect(await a.usage()).toBe(0);
    await a.setSwitch(false);
    expect(ok(await lookupBarcode({ code: NEW_CODE }, a.as()))).toMatchObject({ status: "UNKNOWN" });
    await a.setSwitch(true);

    // From a photo with the AI: the model's digits are checked again on the server.
    globalThis.__intakeFake = { digits: cartonCode(1) };
    expect(ok(await readBarcodeFromImage({ image: page() }, a.as()))).toMatchObject({ status: "KNOWN", variantId: oil.variantId, unitId: oil.carton });
    expect(await a.usage()).toBe(1);
    globalThis.__intakeFake = { digits: NEW_CODE };
    expect(ok(await readBarcodeFromImage({ image: page() }, a.as("MANAGER")))).toEqual({ status: "UNKNOWN", code: NEW_CODE, checked: true });
    expect(await a.usage()).toBe(2);
    // A wrong check digit is never suggested (and the provider's work is still counted).
    globalThis.__intakeFake = { digits: badCheck(NEW_CODE) };
    expect(ok(await readBarcodeFromImage({ image: page() }, a.as()))).toEqual({ status: "INVALID_CHECKSUM" });
    expect(await a.usage()).toBe(3);
    // A replay with the same key answers the same without another half unit.
    globalThis.__intakeFake = { digits: pieceCode(2) };
    const k = key();
    const img = page();
    const first = ok(await readBarcodeFromImage({ image: img }, a.as("OWNER", k)));
    expect(ok(await readBarcodeFromImage({ image: img }, a.as("OWNER", k)))).toEqual(first);
    expect(await a.usage()).toBe(4);
    // The provider unavailable: refused and given back.
    globalThis.__intakeFake = new AiUnavailableError("network");
    expect(await readBarcodeFromImage({ image: page() }, a.as())).toMatchObject({ ok: false, code: "AI_UNAVAILABLE" });
    expect(await a.usage()).toBe(4);
    // No catalog.manage (the purchaser), or no ai.use (the stock keeper): no AI read.
    expect(await readBarcodeFromImage({ image: page() }, a.as("PURCHASING"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await readBarcodeFromImage({ image: page() }, a.as("STOCK"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await a.usage()).toBe(4);
  }, 120_000);

  it("the fake provider is never selected in production", async () => {
    const saved = { env: process.env.NODE_ENV, provider: process.env.INTAKE_PROVIDER, file: process.env.INTAKE_FAKE_FILE };
    const env = process.env as Record<string, string | undefined>;
    try {
      env.NODE_ENV = "production";
      env.INTAKE_PROVIDER = "fake";
      env.INTAKE_FAKE_FILE = "does-not-matter.json";
      globalThis.__intakeFake = RECEIPT;
      const provider = getIntakeProvider();
      await expect(provider.readReceipt([page()], { signal: AbortSignal.timeout(1000) })).rejects.toMatchObject({ code: "AI_UNAVAILABLE", reason: "config" });
      await expect(provider.readBarcode(page(), { signal: AbortSignal.timeout(1000) })).rejects.toMatchObject({ code: "AI_UNAVAILABLE", reason: "config" });
    } finally {
      env.NODE_ENV = saved.env;
      env.INTAKE_PROVIDER = saved.provider;
      env.INTAKE_FAKE_FILE = saved.file;
      if (saved.provider === undefined) delete env.INTAKE_PROVIDER;
      if (saved.file === undefined) delete env.INTAKE_FAKE_FILE;
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The public surface of the intake modules, found from the modules themselves.

const FAKE = "x0000000000000000000000000";

/** A well-formed input per exported write action (permission and gate are checked before any lookup). */
const WRITE_SAMPLES: Record<string, unknown> = {
  "intake.line.resolve": { intakeId: FAKE, lineNo: 1, action: { kind: "DISCARD" }, expectedVersion: 1 },
  "intake.currency": { intakeId: FAKE, currency: "IQD", expectedVersion: 1 },
  "intake.items.create": { intakeId: FAKE, lineNos: [1], expectedVersion: 1 },
  "intake.total.ack": { intakeId: FAKE, expectedVersion: 1 },
  "intake.draft.create": { intakeId: FAKE, expectedVersion: 1 },
  "ai.consent.grant": {},
  "ai.consent.revoke": {},
};

const INTAKE_DIR = fileURLToPath(new URL("../../src/server/intake", import.meta.url));
const MODULES: { file: string; exports: Record<string, unknown> }[] = await Promise.all(
  readdirSync(INTAKE_DIR)
    .filter((f) => /\.ts$/.test(f) && !/\.(test|d)\.ts$/.test(f))
    .map(async (f) => ({ file: relative(INTAKE_DIR, join(INTAKE_DIR, f)), exports: (await import(join(INTAKE_DIR, f))) as Record<string, unknown> })),
);

type Callable = (raw: unknown, meta: ActionMeta) => Promise<{ ok: boolean }>;

function exportedActions() {
  return MODULES.flatMap((m) =>
    Object.entries(m.exports).flatMap(([exportName, value]) => {
      const info = actionInfoOf(value);
      return info ? [{ exportName, ...info, call: value as Callable }] : [];
    }),
  ).sort((x, y) => x.name.localeCompare(y.name));
}

function intakeWriteActions() {
  const writes = exportedActions().filter((x) => x.writes);
  for (const x of writes) if (!(x.name in WRITE_SAMPLES)) throw new Error(`no sample input for the write action "${x.name}": add one to WRITE_SAMPLES`);
  return writes;
}

/** Exported plain functions with an action's signature (raw input, meta): orchestrators over defined actions. */
function plainWrappers(): string[] {
  return MODULES.flatMap((m) =>
    Object.entries(m.exports).flatMap(([name, value]) =>
      typeof value === "function" && !actionInfoOf(value) && /^async function \w+\(raw, meta\)/.test(value.toString()) ? [name] : [],
    ),
  ).sort();
}

/** Steps that run only inside the orchestrators: never exported, so no screen or route can call one. */
const INTERNAL_STEPS = [
  "intake.create",
  "intake.read.start",
  "intake.read.pages",
  "intake.read.fail",
  "intake.read.store",
  "intake.read.sweep",
  "intake.get",
  "intake.list",
  "barcode.read.start",
  "barcode.read.finish",
];

describe("the intake surface", () => {
  it("exports the orchestrators as plain wrappers and the review actions as defined actions; the internal steps are not public", async () => {
    const files = MODULES.map((m) => m.file);
    for (const f of ["barcode.ts", "consent.ts", "matching.ts", "provider.ts", "quota.ts", "receipts.ts"]) expect(files).toContain(f);
    expect(plainWrappers()).toEqual(["createIntake", "getIntake", "listIntakes", "readBarcodeFromImage", "runIntakeRead"]);
    expect(exportedActions().map((x) => [x.name, x.exportName, x.writes])).toEqual([
      ["ai.consent.grant", "grantAiConsent", true],
      ["ai.consent.revoke", "revokeAiConsent", true],
      ["ai.status", "getAiStatus", false],
      ["barcode.lookup", "lookupBarcode", false],
      ["intake.currency", "setIntakeCurrency", true],
      ["intake.draft.create", "createDraftFromIntake", true],
      ["intake.image", "getIntakeImage", false],
      ["intake.items.create", "createIntakeItems", true],
      ["intake.line.resolve", "resolveIntakeLine", true],
      ["intake.total.ack", "acknowledgeIntakeTotal", true],
    ]);
    const names = new Set(exportedActions().map((x) => x.name));
    for (const step of INTERNAL_STEPS) expect(names.has(step), step).toBe(false);
    // Every writing wrapper refuses a missing idempotency key before anything runs (the reads need none).
    const meta = { userId: "u", businessId: "b", idempotencyKey: "" };
    for (const name of ["createIntake", "readBarcodeFromImage", "runIntakeRead"]) {
      const fn = MODULES.map((m) => m.exports[name]).find((x) => typeof x === "function") as Callable;
      const input = name === "createIntake" ? { files: [page()] } : name === "readBarcodeFromImage" ? { image: page() } : name === "listIntakes" ? {} : { intakeId: FAKE };
      expect(await fn(input, meta), name).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
    // Every write has a sample, and every sample names a write.
    const writes = new Set(intakeWriteActions().map((x) => x.name));
    for (const k of Object.keys(WRITE_SAMPLES)) expect(writes.has(k), k).toBe(true);
  });
});
