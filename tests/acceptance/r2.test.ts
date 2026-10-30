import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { setBusinessStatus } from "@/server/admin/lifecycle";
import { createProduct } from "@/server/catalog/products";
import { businessToday } from "@/server/domain/stock";
import { actionInfoOf, type ActionMeta } from "@/server/framework/action";
import { gateOf } from "@/server/framework/gate";
import { adjustStock, reverseStockDocument, writeOffStock } from "@/server/stock/adjust";
import { getStockDocument, listStockDocuments, postStockDocument, saveStockDraft, type DraftLineInput } from "@/server/stock/documents";
import {
  commitOpeningImport,
  downloadOpeningRejected,
  getOpeningImport,
  listOpeningImports,
  stageOpeningImport,
  validateOpeningImport,
} from "@/server/stock/import";
import { rebuildBalances } from "@/server/stock/ledger";
import { getVariantStock, listExpiring, listMovements, listStock, stockContext } from "@/server/stock/queries";
import { buildXlsx } from "../catalog/import/xlsx-fixture";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan, createPlatformAdmin } from "../helpers/fixtures";

/*
 * R2 acceptance (design R2): stock through the real actions against the real database, nothing
 * mocked. Rows that no action creates (plan, platform admin, businesses with staff, subscription,
 * the stock location) come from the shared fixtures, as in the R0 and R1 acceptance tests.
 *
 * One market, one product sold by the piece and by the carton of 12, two batches with different
 * expiry dates: opening stock from an xlsx file, a receipt priced in USD, an adjustment, a
 * write-off and reversals. After every step the stored balances equal the ledger rebuilt from the
 * movements and nothing is negative. Roles without cost.view never receive a value or a cost.
 */

const { db } = useTestDb();

const key = () => randomUUID();
const DAY = 86_400_000;
const U = 1000n; // one base unit (quantities are base units x 1000)

/** Keys that carry a value or a cost; none may reach a caller without cost.view. */
const COST_KEYS = ["valueMinor", "unitCostMinor", "rateMicro", "avgUnitCostMinor", "valueDeltaMinor", "valueAfterMinor", "currency", "totalValueMinor"];

async function business(label: string) {
  const w = await createBusinessWithStaff(db, {
    branches: ["A"],
    staff: [
      { key: "owner", role: "OWNER" }, // cost.view
      { key: "manager", role: "MANAGER", branches: ["A"] }, // receives, imports and adjusts; no cost.view
      { key: "stock", role: "STOCK", branches: ["A"] }, // receives and adjusts; no cost.view
      { key: "cashier", role: "CASHIER", branches: ["A"] }, // reads quantities only
    ],
  });
  const businessId = w.business.id;
  await db.rtBusiness.update({ where: { id: businessId }, data: { status: "ACTIVE", name: label, defaultCurrency: "IQD", enabledCurrencies: ["IQD", "USD"] } });
  const subscription = await db.rtSubscription.create({
    data: { businessId, planCode: "basic", status: "ACTIVE", currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 30 * DAY) },
  });
  const location = await db.rtLocation.create({ data: { businessId, branchId: w.branches.A!.id, name: "المخزن الرئيسي" } });
  const as = (who: string, k = key()): ActionMeta => ({ userId: w.staff[who]!.user.id, businessId, idempotencyKey: k });
  return { ...w, businessId, subscription, locationId: location.id, as };
}
type Shop = Awaited<ReturnType<typeof business>>;

async function world() {
  await createPlan(db, { maxBranches: 3 });
  return { a: await business("سوق أ"), b: await business("سوق ب") };
}

function ok<T>(r: { ok: true; value: T } | { ok: false; code: string; details?: unknown }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code} ${JSON.stringify(r.details ?? {})}`);
  return r.value;
}

/** The business's day plus `offset` days, as YYYY-MM-DD (Asia/Baghdad, the default zone). */
const isoDay = (offset: number) => new Date(businessToday(new Date(), "Asia/Baghdad").getTime() + offset * DAY).toISOString().slice(0, 10);

/**
 * Every path inside `value` whose key is a cost key. A number under `currency` is an import column
 * map (which column holds the currency), not a cost.
 */
function costPaths(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => costPaths(v, `${path}[${i}]`));
  if (value === null || typeof value !== "object" || value instanceof Date) return [];
  return Object.entries(value).flatMap(([k, v]) => [
    ...(COST_KEYS.includes(k) && !(k === "currency" && (typeof v === "number" || v === null) && path.endsWith(".mapping")) ? [`${path}.${k}`] : []),
    ...costPaths(v, `${path}.${k}`),
  ]);
}

/** The result is ok and carries no cost key anywhere. */
function noCost<T>(r: { ok: true; value: T } | { ok: false; code: string; details?: unknown }, label: string): T {
  const v = ok(r);
  expect(costPaths(v), label).toEqual([]);
  return v;
}

/** The ledger invariants: stored balances equal the movements rebuilt, no quantity below zero, no variant value below zero. */
async function ledgerHolds(s: Shop, step: string) {
  const { mismatches } = await db.$transaction((tx) => rebuildBalances(tx, s.businessId, { fix: false }));
  expect(mismatches, step).toEqual([]);
  expect(await db.rtStockBalance.count({ where: { businessId: s.businessId, qty: { lt: 0n } } }), step).toBe(0);
  const perVariant = await db.rtStockBalance.groupBy({ by: ["locationId", "variantId"], where: { businessId: s.businessId }, _sum: { qty: true, valueMinor: true } });
  for (const v of perVariant) {
    expect(v._sum.qty! >= 0n, step).toBe(true);
    expect(v._sum.valueMinor! >= 0n, step).toBe(true);
  }
}

async function totals(s: Shop, variantId: string, batchId?: string) {
  const r = await db.rtStockBalance.aggregate({ where: { businessId: s.businessId, variantId, ...(batchId ? { batchId } : {}) }, _sum: { qty: true, valueMinor: true } });
  return { qty: r._sum.qty ?? 0n, valueMinor: r._sum.valueMinor ?? 0n };
}

/** A product of the shop: a piece (the base unit, with a barcode) and a carton of 12, batches with expiry dates. */
async function milk(s: Shop, barcode: string) {
  const made = ok(
    await createProduct(
      {
        nameAr: "حليب طويل الأجل",
        trackingMode: "BATCH",
        tracksExpiry: true,
        baseUnit: { name: "علبة", barcodes: [barcode] },
        extraUnits: [{ name: "كرتون", factor: 12, barcodes: [] }],
        price: { currency: "IQD", amountMinor: 1500n },
      },
      s.as("owner"),
    ),
  );
  const carton = await db.rtUnit.findFirstOrThrow({ where: { variantId: made.variantId, factor: 12 } });
  return { productId: made.productId, variantId: made.variantId, piece: made.baseUnitId, carton: carton.id };
}

const HEADERS = ["الباركود", "SKU", "الكمية", "الوحدة", "التكلفة", "العملة", "سعر الصرف", "الدفعة", "تاريخ الانتهاء"];

async function receipt(s: Shop, who: string, lines: DraftLineInput[]) {
  const d = ok(await saveStockDraft({ kind: "RECEIPT", supplierRef: "مورد الألبان", lines }, s.as(who)));
  return postStockDocument({ documentId: d.documentId, expectedVersion: d.version }, s.as(who));
}

const versionOf = async (documentId: string) => (await db.rtStockDocument.findUniqueOrThrow({ where: { id: documentId } })).version;

describe("R2 acceptance: stock", () => {
  it("a market's milk: opening from xlsx, a USD receipt, an adjustment, a write-off and reversals keep the ledger exact; no role without cost.view sees a value", async () => {
    const { a } = await world();
    const m = await milk(a, "6281000000101");
    const LATE = isoDay(25); // batch L-A
    const SOON = isoDay(7); // batch L-B, expires first
    await ledgerHolds(a, "empty");

    // 1. Opening stock from an xlsx file, by the manager (imports, cannot see costs).
    const file = buildXlsx([
      HEADERS,
      ["6281000000101", null, "2", "كرتون", "12000", "IQD", null, "L-A", LATE], // 24 pieces at 1,000 each
      ["6281000000101", null, "6", "علبة", "1000", "IQD", null, "L-B", SOON], // 6 pieces at 1,000
      ["6289999999999", null, "1", "علبة", "777", "IQD", null, null, null], // no such item
    ]);
    const staged = ok(await stageOpeningImport({ fileName: "رصيد افتتاحي.xlsx", contentBase64: Buffer.from(file).toString("base64") }, a.as("manager")));
    expect(staged.rowCount).toBe(3);
    const validated = noCost(await validateOpeningImport({ batchId: staged.batchId, mapping: staged.suggestedMapping }, a.as("manager")), "validate (manager)");
    expect(validated.summary).toMatchObject({ total: 3, ok: 2, rejected: 1, hasStock: 0 });
    expect(validated.firstRejected).toEqual([{ rowNumber: 3, reason: "UNKNOWN_ITEM", raw: ["6289999999999", "", "1", "علبة", "", "IQD", "", "", ""] }]);
    const committed = noCost(await commitOpeningImport({ batchId: staged.batchId, expectedVersion: validated.version }, a.as("manager")), "commit (manager)");
    expect(committed.stats).toMatchObject({ total: 3, posted: 2, rejected: 1 });
    expect(committed.documents).toHaveLength(1);
    // The import views: the manager sees blank cost cells, the owner the file as it was.
    const managerView = noCost(await getOpeningImport({ batchId: staged.batchId }, a.as("manager")), "getOpeningImport (manager)");
    expect(managerView.rows.map((r) => r.raw[4])).toEqual(["", "", ""]);
    expect(ok(await getOpeningImport({ batchId: staged.batchId }, a.as("owner"))).rows.map((r) => r.raw[4])).toEqual(["12000", "1000", "777"]);
    noCost(await listOpeningImports({ page: 0 }, a.as("manager")), "listOpeningImports (manager)");
    expect(ok(await downloadOpeningRejected({ batchId: staged.batchId }, a.as("manager")))).not.toContain("777");
    expect(ok(await downloadOpeningRejected({ batchId: staged.batchId }, a.as("owner")))).toContain("777");

    const [batchA, batchB] = await Promise.all(["L-A", "L-B"].map((code) => db.rtBatch.findFirstOrThrow({ where: { businessId: a.businessId, variantId: m.variantId, code } })));
    expect(batchA!.expiryDate!.toISOString().slice(0, 10)).toBe(LATE);
    expect(batchB!.expiryDate!.toISOString().slice(0, 10)).toBe(SOON);
    expect(await totals(a, m.variantId)).toEqual({ qty: 30n * U, valueMinor: 30_000n });
    expect(await totals(a, m.variantId, batchA!.id)).toMatchObject({ qty: 24n * U });
    expect(await totals(a, m.variantId, batchB!.id)).toMatchObject({ qty: 6n * U });
    await ledgerHolds(a, "after the opening import");

    // 2. A receipt priced in USD at 1,500 IQD per dollar, by the stock officer (no cost.view).
    //    1 carton at $9.00 = 13,500 IQD into L-A; 4 pieces at $0.70 = 4,200 IQD into L-B.
    const usd = (amount: string) => ({ amount, currency: "USD" as const });
    const received = noCost(
      await receipt(a, "stock", [
        { variantId: m.variantId, unitId: m.carton, quantity: "1", cost: usd("9.00"), rate: "1500", batchCode: "L-A", expiryDate: LATE },
        { variantId: m.variantId, unitId: m.piece, quantity: "٤", cost: usd("0.70"), rate: "1500", batchCode: "L-B", expiryDate: SOON },
      ]),
      "post receipt (stock)",
    );
    expect(received.lines.map((l) => [l.quantity, l.batchId])).toEqual([
      [12n * U, batchA!.id],
      [4n * U, batchB!.id],
    ]);
    // The owner reads the document with its costs: the USD price, the rate and the IQD value.
    const receiptDoc = ok(await getStockDocument({ documentId: received.documentId }, a.as("owner")));
    expect(receiptDoc.lines.map((l) => [l.currency, l.unitCostMinor, l.rateMicro, l.valueMinor])).toEqual([
      ["USD", 900n, 1_500_000_000n, 13_500n],
      ["USD", 70n, 1_500_000_000n, 4_200n],
    ]);
    noCost(await getStockDocument({ documentId: received.documentId }, a.as("stock")), "getStockDocument (stock)");
    // Weighted average: (30,000 + 13,500 + 4,200) / 46 pieces = 1,036.96 -> 1,037 a piece.
    expect(await totals(a, m.variantId)).toEqual({ qty: 46n * U, valueMinor: 47_700n });
    const afterReceipt = ok(await listStock({ query: "6281000000101" }, a.as("owner"))).rows[0]!;
    expect(afterReceipt).toMatchObject({ variantId: m.variantId, qty: 46n * U, availableQty: 46n * U, valueMinor: 47_700n, avgUnitCostMinor: 1_037n, status: "SOON" });
    expect(afterReceipt.nearestExpiry!.toISOString().slice(0, 10)).toBe(SOON);
    // The last foreign rate is offered to the next receipt (a rate, not a value).
    expect(ok(await stockContext({}, a.as("stock")))).toMatchObject({ canSeeCost: false, lastRateMicro: 1_500_000_000n });
    await ledgerHolds(a, "after the USD receipt");

    // 3. An adjustment: 3 pieces of L-B lost, at the average: 47,700 x 3 / 46 = 3,110.9 -> 3,111.
    const lost = noCost(
      await adjustStock({ variantId: m.variantId, unitId: m.piece, batchId: batchB!.id, quantity: "3", direction: "OUT", reason: "LOST" }, a.as("stock")),
      "adjust (stock)",
    );
    expect(lost.lines[0]).toMatchObject({ quantity: 3n * U, batchId: batchB!.id });
    expect(await totals(a, m.variantId)).toEqual({ qty: 43n * U, valueMinor: 44_589n });
    expect(await totals(a, m.variantId, batchB!.id)).toMatchObject({ qty: 7n * U });
    await ledgerHolds(a, "after the adjustment");

    // 4. A write-off: one damaged carton of L-A, by the manager: 44,589 x 12 / 43 = 12,443.4 -> 12,443.
    const damaged = noCost(
      await writeOffStock({ variantId: m.variantId, unitId: m.carton, batchId: batchA!.id, quantity: "1", reason: "DAMAGED" }, a.as("manager")),
      "write-off (manager)",
    );
    expect(damaged).toMatchObject({ kind: "WRITE_OFF", direction: "OUT" });
    expect(await totals(a, m.variantId)).toEqual({ qty: 31n * U, valueMinor: 32_146n });
    expect(await totals(a, m.variantId, batchA!.id)).toMatchObject({ qty: 24n * U });
    // More than is left in the batch is refused, and nothing moves.
    expect(await writeOffStock({ variantId: m.variantId, unitId: m.piece, batchId: batchB!.id, quantity: "8", reason: "EXPIRED" }, a.as("owner"))).toMatchObject({
      ok: false,
      code: "STOCK_NEGATIVE",
    });
    expect(await totals(a, m.variantId)).toEqual({ qty: 31n * U, valueMinor: 32_146n });
    await ledgerHolds(a, "after the write-off");

    // 5. Reversals restore the exact values: the write-off (by the owner, who sees the value)...
    const undoWriteOff = ok(await reverseStockDocument({ documentId: damaged.documentId, expectedVersion: await versionOf(damaged.documentId) }, a.as("owner")));
    expect(undoWriteOff).toMatchObject({ kind: "REVERSAL", reversesDocumentId: damaged.documentId });
    expect(undoWriteOff.lines[0]).toMatchObject({ quantity: 12n * U, batchId: batchA!.id, valueMinor: 12_443n });
    expect(await totals(a, m.variantId)).toEqual({ qty: 43n * U, valueMinor: 44_589n });
    await ledgerHolds(a, "after reversing the write-off");
    // ...and the adjustment (by the stock officer, who does not): back to the receipt's numbers.
    noCost(await reverseStockDocument({ documentId: lost.documentId, expectedVersion: await versionOf(lost.documentId) }, a.as("stock")), "reverse (stock)");
    expect(await totals(a, m.variantId)).toEqual({ qty: 46n * U, valueMinor: 47_700n });
    expect(await totals(a, m.variantId, batchA!.id)).toMatchObject({ qty: 36n * U });
    expect(await totals(a, m.variantId, batchB!.id)).toMatchObject({ qty: 10n * U });
    // A document is reversed once.
    expect(await reverseStockDocument({ documentId: lost.documentId, expectedVersion: await versionOf(lost.documentId) }, a.as("owner"))).toMatchObject({
      ok: false,
      code: "STOCK_RULE",
      details: { reason: "ALREADY_REVERSED" },
    });
    await ledgerHolds(a, "after reversing the adjustment");

    // The reads. Expiring: L-B (7 days) before L-A (25 days), both soon (the 30-day default).
    const expiring = noCost(await listExpiring({}, a.as("owner")), "listExpiring (owner)").rows;
    expect(expiring.map((r) => [r.batchId, r.code, r.daysLeft, r.status, r.qty])).toEqual([
      [batchB!.id, "L-B", 7, "SOON", 10n * U],
      [batchA!.id, "L-A", 25, "SOON", 36n * U],
    ]);
    expect(expiring[1]!.breakdown).toEqual({ parts: [{ name: "كرتون", count: 3n }], remainder: 0n });
    expect(ok(await listExpiring({ withinDays: 10 }, a.as("cashier"))).rows.map((r) => r.code)).toEqual(["L-B"]);
    // One variant: its batches earliest first, its total with the value for the owner only.
    const variant = ok(await getVariantStock({ variantId: m.variantId }, a.as("owner")));
    expect(variant.batches.map((b) => [b.code, b.qty])).toEqual([
      ["L-B", 10n * U],
      ["L-A", 36n * U],
    ]);
    expect(variant.total).toMatchObject({ qty: 46n * U, valueMinor: 47_700n, avgUnitCostMinor: 1_037n });
    // The movement history: every step, newest first, with the running balance.
    const moves = ok(await listMovements({ variantId: m.variantId, limit: 50 }, a.as("owner"))).rows;
    expect(moves.map((r) => [r.documentKind, r.qtyDelta, r.qtyAfter, r.valueDeltaMinor, r.valueAfterMinor])).toEqual([
      ["REVERSAL", 3n * U, 46n * U, 3_111n, 47_700n],
      ["REVERSAL", 12n * U, 43n * U, 12_443n, 44_589n],
      ["WRITE_OFF", -12n * U, 31n * U, -12_443n, 32_146n],
      ["ADJUSTMENT", -3n * U, 43n * U, -3_111n, 44_589n],
      ["RECEIPT", 4n * U, 46n * U, 4_200n, 47_700n],
      ["RECEIPT", 12n * U, 42n * U, 13_500n, 43_500n],
      ["OPENING", 6n * U, 30n * U, 6_000n, 30_000n],
      ["OPENING", 24n * U, 24n * U, 24_000n, 24_000n],
    ]);

    // No role without cost.view receives a value or a cost from any read.
    for (const who of ["manager", "stock", "cashier"]) {
      noCost(await listStock({ query: "" }, a.as(who)), `listStock (${who})`);
      noCost(await listStock({ query: "", expiringOnly: true }, a.as(who)), `listStock expiring (${who})`);
      noCost(await getVariantStock({ variantId: m.variantId, includeEmpty: true }, a.as(who)), `getVariantStock (${who})`);
      noCost(await listMovements({ variantId: m.variantId }, a.as(who)), `listMovements (${who})`);
      noCost(await listExpiring({}, a.as(who)), `listExpiring (${who})`);
      noCost(await listStockDocuments({}, a.as(who)), `listStockDocuments (${who})`);
      noCost(await stockContext({}, a.as(who)), `stockContext (${who})`);
      for (const doc of ok(await listStockDocuments({ limit: 50 }, a.as("owner"))).rows) {
        noCost(await getStockDocument({ documentId: doc.id }, a.as(who)), `getStockDocument ${doc.kind} (${who})`);
      }
    }
    // The cashier still sees the quantities.
    expect(ok(await listStock({ query: "6281000000101" }, a.as("cashier"))).rows[0]).toMatchObject({ qty: 46n * U, status: "SOON" });
    // The owner does see them (the scan above is not vacuous).
    expect(costPaths(ok(await listMovements({ variantId: m.variantId }, a.as("owner")))).length).toBeGreaterThan(0);
    // And no stored replay of an action keeps one.
    const idem = JSON.stringify(await db.rtIdempotency.findMany({ where: { scope: a.businessId } }), (_k, x) => (typeof x === "bigint" ? x.toString() : x));
    for (const k of ["valueMinor", "unitCostMinor", "rateMicro"]) expect(idem).not.toContain(k);
  }, 120_000);

  it("isolation: business B neither sees nor changes A's stock, documents, batches or imports", async () => {
    const { a, b } = await world();
    const m = await milk(a, "6281000000201");
    const theirs = await milk(b, "6281000000201"); // the same barcode is fine in another business
    const file = buildXlsx([HEADERS, ["6281000000201", null, "5", "علبة", "1000", "IQD", null, "L-1", isoDay(5)]]);
    const staged = ok(await stageOpeningImport({ fileName: "stock.xlsx", contentBase64: Buffer.from(file).toString("base64") }, a.as("owner")));
    const v = ok(await validateOpeningImport({ batchId: staged.batchId, mapping: staged.suggestedMapping }, a.as("owner")));
    const opening = ok(await commitOpeningImport({ batchId: staged.batchId, expectedVersion: v.version }, a.as("owner"))).documents[0]!;
    const draft = ok(await saveStockDraft({ kind: "RECEIPT", lines: [{ variantId: m.variantId, unitId: m.piece, quantity: "1", cost: { amount: "1000", currency: "IQD" }, batchCode: "L-1", expiryDate: isoDay(5) }] }, a.as("owner")));
    const batch = await db.rtBatch.findFirstOrThrow({ where: { businessId: a.businessId } });
    const before = await totals(a, m.variantId);
    expect(before).toEqual({ qty: 5n * U, valueMinor: 5_000n });

    // Reads: nothing of A.
    expect(ok(await listStock({ query: "6281000000201" }, b.as("owner"))).rows.map((r) => r.variantId)).toEqual([theirs.variantId]);
    expect(ok(await listStock({ query: "" }, b.as("owner"))).rows.every((r) => r.variantId === theirs.variantId)).toBe(true);
    expect(ok(await listExpiring({}, b.as("owner"))).rows).toEqual([]);
    expect(ok(await listStockDocuments({}, b.as("owner"))).rows).toEqual([]);
    expect(ok(await listOpeningImports({ page: 0 }, b.as("owner")))).toEqual([]);
    expect(await getVariantStock({ variantId: m.variantId }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await listMovements({ variantId: m.variantId }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await getStockDocument({ documentId: opening.documentId }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await getOpeningImport({ batchId: staged.batchId }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await downloadOpeningRejected({ batchId: staged.batchId }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    // Writes on A's rows from B: NOT_FOUND, and nothing moves.
    expect(await postStockDocument({ documentId: draft.documentId, expectedVersion: draft.version }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await reverseStockDocument({ documentId: opening.documentId, expectedVersion: await versionOf(opening.documentId) }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await adjustStock({ variantId: m.variantId, unitId: m.piece, batchId: batch.id, quantity: "1", direction: "OUT", reason: "LOST" }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await writeOffStock({ variantId: theirs.variantId, unitId: theirs.piece, batchId: batch.id, quantity: "1", reason: "DAMAGED" }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await saveStockDraft({ kind: "RECEIPT", lines: [{ variantId: m.variantId, unitId: m.piece, quantity: "1", cost: { amount: "1", currency: "IQD" }, expiryDate: isoDay(5) }] }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await validateOpeningImport({ batchId: staged.batchId, mapping: staged.suggestedMapping }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await commitOpeningImport({ batchId: staged.batchId }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    // B's owner acting inside A (not a member): refused before anything.
    expect(await listStock({ query: "" }, { ...b.as("owner"), businessId: a.businessId })).toMatchObject({ ok: false, code: "FORBIDDEN" });

    expect(await totals(a, m.variantId)).toEqual(before);
    expect(await db.rtStockDocument.findUniqueOrThrow({ where: { id: draft.documentId } })).toMatchObject({ status: "DRAFT" });
    expect(await db.rtStockMovement.count({ where: { businessId: b.businessId } })).toBe(0);
    expect(await db.rtStockDocument.count({ where: { businessId: b.businessId } })).toBe(0);
    await ledgerHolds(a, "A after B's attempts");
    await ledgerHolds(b, "B");
  });

  it("READ_ONLY refuses every stock write, through an expired subscription and through suspension; reads still work", async () => {
    const { a } = await world();
    const admin = await createPlatformAdmin(db);
    const m = await milk(a, "6281000000301");
    const posted = ok(await receipt(a, "owner", [{ variantId: m.variantId, unitId: m.carton, quantity: "1", cost: { amount: "12000", currency: "IQD" }, batchCode: "L-1", expiryDate: isoDay(3) }]));
    const file = buildXlsx([HEADERS, ["6281000000301", null, "1", "علبة", "1000", "IQD", null, "L-2", isoDay(40)]]);
    const staged = ok(await stageOpeningImport({ fileName: "later.xlsx", contentBase64: Buffer.from(file).toString("base64") }, a.as("owner")));
    const writes = writeActions();
    expect(writes.filter((w) => w.allowWhenReadOnly).map((w) => w.name)).toEqual([]);

    async function everyWriteRefused() {
      expect(await gateOf(a.businessId, db)).toBe("READ_ONLY");
      const counts = async () => ({
        documents: await db.rtStockDocument.count({ where: { businessId: a.businessId } }),
        movements: await db.rtStockMovement.count({ where: { businessId: a.businessId } }),
        batches: await db.rtImportBatch.count({ where: { businessId: a.businessId } }),
        audits: await db.rtAuditLog.count({ where: { businessId: a.businessId } }),
      });
      const before = await counts();
      for (const w of writes) {
        expect(await w.call(sampleInput(w.name), a.as("owner")), w.name).toMatchObject({ ok: false, code: "READ_ONLY" });
      }
      for (const [name, wrapper] of PLAIN_WRAPPERS) {
        expect(await wrapper(sampleInput(name), a.as("owner")), name).toMatchObject({ ok: false, code: "READ_ONLY" });
      }
      // The real rows too, not only the samples.
      expect(await reverseStockDocument({ documentId: posted.documentId, expectedVersion: await versionOf(posted.documentId) }, a.as("owner"))).toMatchObject({ ok: false, code: "READ_ONLY" });
      expect(await validateOpeningImport({ batchId: staged.batchId, mapping: staged.suggestedMapping }, a.as("owner"))).toMatchObject({ ok: false, code: "READ_ONLY" });
      expect(await counts()).toEqual(before);
      // Reads go on.
      expect(ok(await listStock({ query: "6281000000301" }, a.as("cashier"))).rows[0]).toMatchObject({ qty: 12n * U });
      expect(ok(await listExpiring({}, a.as("cashier"))).rows).toHaveLength(1);
      expect(ok(await getVariantStock({ variantId: m.variantId }, a.as("owner"))).total).toMatchObject({ qty: 12n * U, valueMinor: 12_000n });
      expect(ok(await listMovements({ variantId: m.variantId }, a.as("owner"))).rows).toHaveLength(1);
      expect(ok(await getStockDocument({ documentId: posted.documentId }, a.as("manager"))).status).toBe("POSTED");
      expect(ok(await listStockDocuments({}, a.as("owner"))).rows).toHaveLength(1);
      expect(ok(await stockContext({}, a.as("owner")))).toMatchObject({ canReceive: true });
      expect(ok(await listOpeningImports({ page: 0 }, a.as("owner")))).toHaveLength(1);
      expect(ok(await getOpeningImport({ batchId: staged.batchId }, a.as("owner"))).rows).toHaveLength(1);
      await ledgerHolds(a, "READ_ONLY");
    }

    // 1. The subscription ended and its grace period passed.
    await db.rtSubscription.update({ where: { id: a.subscription.id }, data: { currentPeriodStart: new Date(Date.now() - 60 * DAY), currentPeriodEnd: new Date(Date.now() - 30 * DAY), graceDays: 7 } });
    await everyWriteRefused();

    // 2. Back to FULL (writes work again), then suspended by the platform.
    await db.rtSubscription.update({ where: { id: a.subscription.id }, data: { currentPeriodStart: a.subscription.currentPeriodStart, currentPeriodEnd: a.subscription.currentPeriodEnd } });
    expect(await gateOf(a.businessId, db)).toBe("FULL");
    const biz = await db.rtBusiness.findUniqueOrThrow({ where: { id: a.businessId } });
    ok(await setBusinessStatus({ businessId: a.businessId, next: "SUSPENDED", reason: "متأخر عن دفع الاشتراك", expectedVersion: biz.version }, { userId: admin.id, idempotencyKey: key() }));
    await everyWriteRefused();
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// Every stock write action, found from the modules themselves (so a new one cannot be forgotten).

const FAKE = "x0000000000000000000000000";

/**
 * A well-formed input per write action: the permission and the gate are checked after the input
 * parses and before anything is looked up, so ids need not exist. A write without an entry here
 * fails the test: adding an action means adding it here, and so testing it.
 */
const SAMPLES: Record<string, unknown> = {
  "stock.document.saveDraft": { kind: "RECEIPT", lines: [] },
  "stock.document.discard": { documentId: FAKE, expectedVersion: 1 },
  "stock.document.post": { documentId: FAKE, expectedVersion: 1 },
  "stock.adjust": { variantId: FAKE, unitId: FAKE, quantity: "1", direction: "IN", reason: "COUNT_FIX" },
  "stock.writeOff": { variantId: FAKE, unitId: FAKE, quantity: "1", reason: "DAMAGED" },
  "stock.reverse": { documentId: FAKE, expectedVersion: 1 },
  "stock.import.stage": { fileName: "a.csv", contentBase64: Buffer.from("الباركود,الكمية\n1,1\n").toString("base64") },
  "stock.import.validate": { batchId: FAKE, mapping: { barcode: 0, quantity: 1 } },
  "stock.import.commit": { batchId: FAKE },
  // The plain wrapper (several transactions, each a defined action), found below.
  commitOpeningImport: { batchId: FAKE },
};

function sampleInput(name: string): unknown {
  if (!(name in SAMPLES)) throw new Error(`no sample input for the write action "${name}": add one to SAMPLES in tests/acceptance/r2.test.ts`);
  return SAMPLES[name];
}

type WriteAction = { name: string; allowWhenReadOnly: boolean; call: (raw: unknown, meta: ActionMeta) => Promise<{ ok: boolean }> };

/** Every source module under src/server/stock (a new file is picked up without editing this test). */
const STOCK_DIR = fileURLToPath(new URL("../../src/server/stock", import.meta.url));
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(e.name) && !/\.(test|d)\.tsx?$/.test(e.name) ? [full] : [];
  });
}
const MODULES: { file: string; exports: Record<string, unknown> }[] = await Promise.all(
  sourceFiles(STOCK_DIR).map(async (file) => ({ file: relative(STOCK_DIR, file), exports: (await import(file)) as Record<string, unknown> })),
);

function writeActions(): WriteAction[] {
  const out = new Map<string, WriteAction>();
  for (const mod of MODULES) {
    for (const value of Object.values(mod.exports)) {
      const info = actionInfoOf(value);
      if (info?.writes) {
        out.set(info.name, { name: info.name, allowWhenReadOnly: info.allowWhenReadOnly, call: value as WriteAction["call"] });
        sampleInput(info.name); // fails loudly when a new write has no sample
      }
    }
  }
  return [...out.values()].sort((x, y) => x.name.localeCompare(y.name));
}

/** Exported plain functions that run defined actions keyed from the caller's idempotency key. */
function plainWrappers(): [string, (raw: unknown, meta: ActionMeta) => Promise<{ ok: boolean }>][] {
  const out = new Map<string, (raw: unknown, meta: ActionMeta) => Promise<{ ok: boolean }>>();
  for (const mod of MODULES) {
    for (const [name, value] of Object.entries(mod.exports)) {
      if (typeof value !== "function" || actionInfoOf(value)) continue;
      if (!value.toString().includes("idempotencyKey")) continue;
      sampleInput(name);
      out.set(name, value as (raw: unknown, meta: ActionMeta) => Promise<{ ok: boolean }>);
    }
  }
  return [...out.entries()].sort(([x], [y]) => x.localeCompare(y));
}
const PLAIN_WRAPPERS = plainWrappers();

describe("the enumeration itself", () => {
  it("finds every stock module, its writes and its plain wrapper", () => {
    const files = MODULES.map((m) => m.file.replaceAll("\\", "/"));
    for (const f of ["adjust.ts", "documents.ts", "import.ts", "ledger.ts", "posting.ts", "queries.ts"]) expect(files).toContain(f);
    expect(PLAIN_WRAPPERS.map(([n]) => n)).toEqual(["commitOpeningImport"]);
    const names = new Set(writeActions().map((w) => w.name));
    for (const k of Object.keys(SAMPLES)) expect(names.has(k) || PLAIN_WRAPPERS.some(([n]) => n === k), k).toBe(true);
  });
});
