import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// Every real role holding catalog.import also holds multiBranch.access, so a branch-limited importer
// (the onHand guard) is reached by withholding that one permission while `flags.limitBranches` is set.
const flags = vi.hoisted(() => ({ limitBranches: false }));
vi.mock("@/server/domain/permissions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/domain/permissions")>();
  return {
    ...real,
    can: (role: Parameters<typeof real.can>[0], p: Parameters<typeof real.can>[1]) => (flags.limitBranches && p === "multiBranch.access" ? false : real.can(role, p)),
  };
});

import type { RtTrackingMode } from "@/generated/prisma/client";
import { businessToday } from "@/server/domain/stock";
import { reverseStockDocument } from "@/server/stock/adjust";
import { postStockDocument, saveStockDraft, type DraftLineInput } from "@/server/stock/documents";
import {
  OPENING_SLICE_SIZE,
  autoMapOpeningHeaders,
  commitOpeningImport,
  commitOpeningSlice,
  downloadOpeningRejected,
  getOpeningImport,
  listOpeningImports,
  stageOpeningImport,
  validateOpeningImport,
} from "@/server/stock/import";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan } from "../helpers/fixtures";

const { db } = useTestDb();

const DAY = 86_400_000;
const U = 1000n; // one base unit (quantities are base x 1000)
const key = () => randomUUID();
let seq = 0;

type ItemOpts = { trackingMode?: RtTrackingMode; tracksExpiry?: boolean; isTestData?: boolean; archived?: boolean };

/** An active business with branches Main and Second (one location each) and staff: owner, manager, stock officer, cashier (Main), "far" manager (Second only). */
async function shop(label = "A") {
  if ((await db.rtPlan.count()) === 0) await createPlan(db, { maxBranches: 3 });
  const w = await createBusinessWithStaff(db, {
    branches: ["Main", "Second"],
    staff: [
      { key: "owner", role: "OWNER" },
      { key: "manager", role: "MANAGER", branches: ["Main"] },
      { key: "stock", role: "STOCK", branches: ["Main"] },
      { key: "cashier", role: "CASHIER", branches: ["Main"] },
      { key: "far", role: "MANAGER", branches: ["Second"] },
    ],
  });
  const businessId = w.business.id;
  await db.rtBusiness.update({
    where: { id: businessId },
    data: { status: "ACTIVE", name: label, enabledCurrencies: ["IQD", "USD"], defaultCurrency: "IQD" },
  });
  await db.rtSubscription.create({
    data: { businessId, planCode: "basic", status: "ACTIVE", currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 30 * DAY) },
  });
  const location = await db.rtLocation.create({ data: { businessId, branchId: w.branches.Main!.id, name: "المخزن الرئيسي" } });
  await db.rtLocation.create({ data: { businessId, branchId: w.branches.Second!.id, name: "مخزن الفرع" } });
  // Main stays the oldest branch (the owner's default place).
  await db.rtBranch.update({ where: { id: w.branches.Second!.id }, data: { createdAt: new Date(Date.now() + 60_000) } });
  const as = (who: string, k = key()) => ({ userId: w.staff[who]!.user.id, businessId, idempotencyKey: k });

  /** One product, one variant, a base piece (with `code`) and a carton of 24 (with `code`-C when given). */
  async function item(code: string, o: ItemOpts = {}) {
    const product = await db.rtProduct.create({
      data: {
        businessId,
        nameAr: `صنف ${code}`,
        trackingMode: o.trackingMode ?? (o.tracksExpiry ? "BATCH" : "NONE"),
        tracksExpiry: o.tracksExpiry ?? false,
        isTestData: o.isTestData ?? false,
        archivedAt: o.archived ? new Date() : null,
      },
    });
    const variant = await db.rtVariant.create({ data: { businessId, productId: product.id, sku: `SKU-${++seq}` } });
    const piece = await db.rtUnit.create({ data: { businessId, variantId: variant.id, name: "حبة", factor: 1, isBase: true } });
    const carton = await db.rtUnit.create({ data: { businessId, variantId: variant.id, name: "كرتون", factor: 24 } });
    await db.rtBarcode.create({ data: { businessId, unitId: piece.id, code } });
    return { variantId: variant.id, sku: variant.sku, piece: piece.id, carton: carton.id };
  }

  /** `n` plain items with barcodes code(0..n-1), inserted in bulk. */
  async function manyItems(n: number, code: (i: number) => string) {
    const ids = Array.from({ length: n }, () => ({ p: randomUUID(), v: randomUUID(), u: randomUUID() }));
    await db.rtProduct.createMany({ data: ids.map((x, i) => ({ id: x.p, businessId, nameAr: `مادة ${i}` })) });
    await db.rtVariant.createMany({ data: ids.map((x, i) => ({ id: x.v, businessId, productId: x.p, sku: `M-${i}` })) });
    await db.rtUnit.createMany({ data: ids.map((x) => ({ id: x.u, businessId, variantId: x.v, name: "حبة", factor: 1, isBase: true })) });
    await db.rtBarcode.createMany({ data: ids.map((x, i) => ({ businessId, unitId: x.u, code: code(i) })) });
    return ids.map((x) => x.v);
  }

  const onHand = async (variantId: string) =>
    (await db.rtStockBalance.aggregate({ where: { businessId, variantId }, _sum: { qty: true } }))._sum.qty ?? 0n;
  const totals = async () => {
    const s = await db.rtStockBalance.aggregate({ where: { businessId }, _sum: { qty: true, valueMinor: true } });
    return { qty: s._sum.qty ?? 0n, valueMinor: s._sum.valueMinor ?? 0n };
  };
  const openingDocs = () =>
    db.rtStockDocument.findMany({ where: { businessId, kind: "OPENING" }, orderBy: { number: "asc" }, include: { _count: { select: { lines: true } } } });

  return { ...w, businessId, locationId: location.id, as, item, manyItems, onHand, totals, openingDocs };
}

type Shop = Awaited<ReturnType<typeof shop>>;

const HEADERS = ["الباركود", "SKU", "الكمية", "الوحدة", "التكلفة", "العملة", "سعر الصرف", "الدفعة", "تاريخ الانتهاء"];
type Cells = Partial<Record<"barcode" | "sku" | "quantity" | "unit" | "cost" | "currency" | "rate" | "batch" | "expiry", string>>;
const row = (o: Cells) => [o.barcode ?? "", o.sku ?? "", o.quantity ?? "", o.unit ?? "", o.cost ?? "", o.currency ?? "", o.rate ?? "", o.batch ?? "", o.expiry ?? ""];

function csv(rows: string[][], headers = HEADERS): string {
  const cell = (c: string) => (/[",\r\n\t]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return [headers, ...rows].map((r) => r.map(cell).join(",")).join("\n");
}
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

function value<T>(r: { ok: true; value: T } | { ok: false; code: string; details?: unknown }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code} ${JSON.stringify(r.details ?? {})}`);
  return r.value;
}

async function stage(s: Shop, text: string, who = "owner", fileName = "stock.csv") {
  return value(await stageOpeningImport({ fileName, contentBase64: b64(text) }, s.as(who)));
}

async function stageAndValidate(s: Shop, text: string, who = "owner") {
  const staged = await stage(s, text, who);
  const validated = value(await validateOpeningImport({ batchId: staged.batchId, mapping: staged.suggestedMapping }, s.as(who)));
  return { ...staged, ...validated };
}

const rowsOf = (batchId: string) => db.rtImportRow.findMany({ where: { batchId }, orderBy: { rowNumber: "asc" } });

const isoDay = (offsetDays: number) => new Date(businessToday(new Date(), "Asia/Baghdad").getTime() + offsetDays * DAY).toISOString().slice(0, 10);

async function postOpening(s: Shop, lines: DraftLineInput[], kind: "OPENING" | "RECEIPT" = "OPENING") {
  const d = value(await saveStockDraft({ kind, lines }, s.as("owner")));
  return value(await postStockDocument({ documentId: d.documentId, expectedVersion: d.version }, s.as("owner")));
}

describe("opening stock import", () => {
  it("maps Arabic, English and Kurdish headers", () => {
    expect(autoMapOpeningHeaders(HEADERS)).toEqual({ barcode: 0, sku: 1, quantity: 2, unit: 3, cost: 4, currency: 5, rate: 6, batch: 7, expiry: 8 });
    expect(autoMapOpeningHeaders(["Barcode", "Qty", "Unit cost", "Currency", "Exchange rate", "Lot", "Expiry date"])).toMatchObject({
      barcode: 0,
      quantity: 1,
      cost: 2,
      currency: 3,
      rate: 4,
      batch: 5,
      expiry: 6,
      sku: null,
      unit: null,
    });
    expect(autoMapOpeningHeaders(["بارکۆد", "بڕ", "یەکە", "تێچوو", "بەسەرچوون"])).toMatchObject({ barcode: 0, quantity: 1, unit: 2, cost: 3, expiry: 4 });
  });

  it("1200 rows with mixed errors post only the valid ones and keep the rest with reasons", async () => {
    const s = await shop();
    const code = (i: number) => `62${String(i).padStart(11, "0")}`;
    const variants = await s.manyItems(1000, code);
    const rows: string[][] = [];
    const expected: Record<string, number> = {};
    const bad = (reason: string, r: string[]) => {
      rows.push(r);
      expected[reason] = (expected[reason] ?? 0) + 1;
    };
    let qtySum = 0n;
    for (let i = 0; i < 1000; i++) {
      const q = BigInt((i % 7) + 1);
      qtySum += q;
      rows.push(row({ barcode: code(i), quantity: String(q), cost: "1000" }));
      // Every fifth valid row is followed by a bad one, so every slice meets rejects.
      if (i % 5 === 0) {
        const k = i / 5;
        if (k % 5 === 0) bad("UNKNOWN_ITEM", row({ barcode: `99${String(k).padStart(11, "0")}`, quantity: "1" }));
        else if (k % 5 === 1) bad("BAD_QUANTITY", row({ barcode: code(i), quantity: k % 2 ? "abc" : "-3" }));
        else if (k % 5 === 2) bad("DUPLICATE_IN_FILE", row({ barcode: code(i), quantity: "2", cost: "1000" }));
        else if (k % 5 === 3) bad("MISSING_IDENTIFIER", row({ quantity: "4" }));
        else bad("UNKNOWN_CURRENCY", row({ barcode: code(i), quantity: "1", cost: "5", currency: "EUR" }));
      }
    }
    expect(rows).toHaveLength(1200);
    const v = await stageAndValidate(s, csv(rows));
    expect(v.summary).toMatchObject({ total: 1200, ok: 1000, rejected: 200, hasStock: 0 });

    const k = key();
    const c = value(await commitOpeningImport({ batchId: v.batchId }, s.as("owner", k)));
    expect(c.alreadyCommitted).toBe(false);
    expect(c.stats).toMatchObject({ total: 1200, posted: 1000, rejected: 200, skipped: 0 });
    expect(c.valueMinor).toBe(qtySum * 1000n); // the owner sees the value

    // Slices of at most 500 lines, each ONE posted OPENING document linked to the batch.
    const docs = await s.openingDocs();
    expect(OPENING_SLICE_SIZE).toBe(500);
    expect(docs.map((d) => [d.status, d.importBatchId, d._count.lines])).toEqual([
      ["POSTED", v.batchId, 500],
      ["POSTED", v.batchId, 500],
    ]);
    expect(c.documents.map((d) => d.number)).toEqual(docs.map((d) => d.number));
    expect(await s.totals()).toEqual({ qty: qtySum * U, valueMinor: qtySum * 1000n });
    expect(await s.onHand(variants[7]!)).toBe(1n * U);

    // Rejected rows keep their reasons; nothing of them was posted.
    const stored = await rowsOf(v.batchId);
    const reasons: Record<string, number> = {};
    for (const r of stored.filter((r) => r.status === "REJECTED")) reasons[r.reason!] = (reasons[r.reason!] ?? 0) + 1;
    expect(reasons).toEqual(expected);
    expect(stored.filter((r) => r.status === "COMMITTED")).toHaveLength(1000);
    expect(await db.rtImportBatch.findUniqueOrThrow({ where: { id: v.batchId } })).toMatchObject({ status: "COMMITTED", kind: "OPENING_STOCK" });

    // The rejected-rows file: the file's columns plus the reason.
    const file = value(await downloadOpeningRejected({ batchId: v.batchId }, s.as("owner")));
    const lines = file.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines).toHaveLength(201);
    expect(lines[0]).toBe([...HEADERS, "reason"].join(","));
    expect(lines.filter((l) => l.endsWith(",DUPLICATE_IN_FILE"))).toHaveLength(expected.DUPLICATE_IN_FILE!);

    // The idempotency records keep no cost and no cell of the file.
    const idem = JSON.stringify(await db.rtIdempotency.findMany({ where: { scope: s.businessId } }), (_, x) => (typeof x === "bigint" ? x.toString() : x));
    expect(idem).not.toContain("valueMinor");
    expect(idem).not.toContain("unitCostMinor");
    expect(idem).not.toContain("62000000000");
  }, 120_000);

  it("the same file twice posts once", async () => {
    const s = await shop();
    const a = await s.item("1001");
    const text = csv([row({ barcode: "1001", quantity: "10", cost: "250" })]);
    // Two batches of the same file staged before either is committed: only the first posts.
    const first = await stageAndValidate(s, text);
    const early = await stageAndValidate(s, text);
    value(await commitOpeningImport({ batchId: first.batchId }, s.as("owner")));
    expect(await s.onHand(a.variantId)).toBe(10n * U);
    expect(await commitOpeningImport({ batchId: early.batchId }, s.as("owner"))).toMatchObject({ ok: false, code: "IMPORT_SAME_FILE" });
    // Staging it again is refused, with the committed batch named.
    expect(await stageOpeningImport({ fileName: "again.csv", contentBase64: b64(text) }, s.as("manager"))).toMatchObject({
      ok: false,
      code: "IMPORT_SAME_FILE",
      details: { batchId: first.batchId },
    });
    expect(await s.onHand(a.variantId)).toBe(10n * U);
    expect(await s.openingDocs()).toHaveLength(1);

    // Still refused after its document was reversed (ruling).
    const doc = (await s.openingDocs())[0]!;
    value(await reverseStockDocument({ documentId: doc.id, expectedVersion: doc.version }, s.as("owner")));
    expect(await s.onHand(a.variantId)).toBe(0n);
    expect(await stageOpeningImport({ fileName: "again.csv", contentBase64: b64(text) }, s.as("owner"))).toMatchObject({ ok: false, code: "IMPORT_SAME_FILE" });
    // A different file (one more row) is a new import.
    await s.item("1002");
    value(await stageOpeningImport({ fileName: "other.csv", contentBase64: b64(csv([row({ barcode: "1001", quantity: "10" }), row({ barcode: "1002", quantity: "1" })])) }, s.as("owner")));
  });

  it("two commits of one batch post nothing the second time", async () => {
    const s = await shop();
    const a = await s.item("2001");
    const b = await s.item("2002");
    const v = await stageAndValidate(s, csv([row({ barcode: "2001", quantity: "3", cost: "100" }), row({ barcode: "2002", quantity: "2", unit: "كرتون", cost: "2400" })]));
    const k = key();
    const first = value(await commitOpeningImport({ batchId: v.batchId, expectedVersion: v.version }, s.as("owner", k)));
    expect(first).toMatchObject({ alreadyCommitted: false, stats: { posted: 2 } });
    // The same request again (same key) and a new request (new key): nothing more is posted.
    expect(value(await commitOpeningImport({ batchId: v.batchId, expectedVersion: v.version }, s.as("owner", k)))).toMatchObject({ stats: { posted: 2 } });
    const second = value(await commitOpeningImport({ batchId: v.batchId, includeHasStock: true }, s.as("manager")));
    expect(second).toMatchObject({ alreadyCommitted: true, stats: first.stats });
    expect(await s.onHand(a.variantId)).toBe(3n * U);
    expect(await s.onHand(b.variantId)).toBe(48n * U);
    expect(await s.openingDocs()).toHaveLength(1);

    // Two commits racing on one batch: the batch lock queues them, one does the work.
    const c = await s.item("2003");
    const v2 = await stageAndValidate(s, csv([row({ barcode: "2003", quantity: "5" })]));
    const raced = await Promise.all([
      commitOpeningImport({ batchId: v2.batchId }, s.as("owner")),
      commitOpeningImport({ batchId: v2.batchId }, s.as("manager")),
    ]);
    expect(raced.every((r) => r.ok)).toBe(true);
    expect(await s.onHand(c.variantId)).toBe(5n * U);
    expect(await s.openingDocs()).toHaveLength(2);
    // A batch that was never validated cannot be committed; a re-validated one refuses a stale version.
    await s.item("2004");
    const staged = await stage(s, csv([row({ barcode: "2004", quantity: "1" })]));
    expect(await commitOpeningImport({ batchId: staged.batchId }, s.as("owner"))).toMatchObject({ ok: false, code: "IMPORT_NOT_VALIDATED" });
    const v3 = value(await validateOpeningImport({ batchId: staged.batchId, mapping: staged.suggestedMapping }, s.as("owner")));
    value(await validateOpeningImport({ batchId: staged.batchId, mapping: staged.suggestedMapping }, s.as("owner")));
    expect(await commitOpeningImport({ batchId: staged.batchId, expectedVersion: v3.version }, s.as("owner"))).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
  });

  it("an unknown barcode, a SERIAL item, a trial item and a missing expiry are rejected with reasons", async () => {
    const s = await shop();
    await s.item("3001", { trackingMode: "SERIAL" });
    await s.item("3002", { isTestData: true });
    const milk = await s.item("3003", { tracksExpiry: true });
    await s.item("3004", { archived: true });
    const plain = await s.item("3005");
    const v = await stageAndValidate(
      s,
      csv([
        row({ barcode: "3999", quantity: "1" }), // 1 unknown
        row({ barcode: "3001", quantity: "1" }), // 2 SERIAL
        row({ barcode: "3002", quantity: "1" }), // 3 trial
        row({ barcode: "3003", quantity: "1" }), // 4 tracksExpiry, no expiry
        row({ barcode: "3003", quantity: "2", batch: "L1", expiry: isoDay(-3) }), // 5 past expiry: accepted, flagged
        row({ barcode: "3003", quantity: "4", batch: "L2", expiry: "2099-13-40" }), // 6 not a date
        row({ barcode: "3004", quantity: "1" }), // 7 archived
        row({ barcode: "3005", quantity: "1", batch: "X" }), // 8 batch on an untracked item
        row({ barcode: "3005", quantity: "1", cost: "2", currency: "USD" }), // 9 foreign cost without rate
        row({ barcode: "3005", quantity: "1.5" }), // 10 decimals on a whole-piece unit
        row({ barcode: "3005", quantity: "1", unit: "صندوق" }), // 11 unknown unit
        row({ sku: plain.sku, quantity: "2", unit: "كرتون", cost: "2", currency: "USD", rate: "1,310" }), // 12 ok, by SKU and unit name
        row({ barcode: "3005", sku: "SKU-OTHER", quantity: "1" }), // 13 SKU of no such item
        row({ barcode: "3005", quantity: "3" }), // 14 ok, no cost
      ]),
    );
    expect(v.summary).toMatchObject({ total: 14, ok: 3, rejected: 11, expired: 1, costMissing: 2 });
    const stored = await rowsOf(v.batchId);
    expect(stored.map((r) => [r.rowNumber, r.status, r.reason])).toEqual([
      [1, "REJECTED", "UNKNOWN_ITEM"],
      [2, "REJECTED", "SERIAL_NOT_SUPPORTED"],
      [3, "REJECTED", "TEST_ITEM"],
      [4, "REJECTED", "EXPIRY_REQUIRED"],
      [5, "OK", null],
      [6, "REJECTED", "BAD_EXPIRY"],
      [7, "REJECTED", "ARCHIVED"],
      [8, "REJECTED", "BATCH_NOT_TRACKED"],
      [9, "REJECTED", "RATE_REQUIRED"],
      [10, "REJECTED", "BAD_QUANTITY"],
      [11, "REJECTED", "UNKNOWN_UNIT"],
      [12, "OK", null],
      [13, "REJECTED", "SKU_MISMATCH"],
      [14, "OK", null],
    ]);
    const page = value(await getOpeningImport({ batchId: v.batchId, status: "OK" }, s.as("owner")));
    expect(page.rows.map((r) => [r.rowNumber, r.flags])).toEqual([
      [5, ["EXPIRED", "COST_MISSING"]],
      [12, []],
      [14, ["COST_MISSING"]],
    ]);

    const c = value(await commitOpeningImport({ batchId: v.batchId }, s.as("owner")));
    expect(c.stats).toMatchObject({ posted: 3, rejected: 11 });
    expect(await s.onHand(milk.variantId)).toBe(2n * U);
    expect(await s.onHand(plain.variantId)).toBe(51n * U);
    // 2 cartons at 2 USD each, at 1310 IQD per USD.
    expect((await s.totals()).valueMinor).toBe(5_240n);
  });

  it("a row for an item that already has stock is flagged before commit", async () => {
    const s = await shop();
    const a = await s.item("4001");
    const b = await s.item("4002");
    const moved = await s.item("4003");
    await postOpening(s, [{ variantId: a.variantId, unitId: a.piece, quantity: "7", cost: { amount: "100", currency: "IQD" } }]);
    await postOpening(s, [{ variantId: moved.variantId, unitId: moved.piece, quantity: "1", cost: { amount: "100", currency: "IQD" } }], "RECEIPT");
    const text = csv([row({ barcode: "4001", quantity: "5", cost: "100" }), row({ barcode: "4002", quantity: "2" }), row({ barcode: "4003", quantity: "1" })]);

    const v = await stageAndValidate(s, text, "manager");
    expect(v.summary).toMatchObject({ ok: 2, hasStock: 1, rejected: 1 });
    // The preview names the current on-hand quantity (no cost) of the item that already has stock.
    expect(v.hasStock).toEqual([{ rowNumber: 1, variantId: a.variantId, onHand: 7n * U }]);
    const page = value(await getOpeningImport({ batchId: v.batchId }, s.as("manager")));
    expect(page.rows.map((r) => [r.rowNumber, r.status, r.reason, r.flags, r.onHand])).toEqual([
      [1, "OK", "HAS_STOCK", ["HAS_STOCK"], 7n * U],
      [2, "OK", null, ["COST_MISSING"], null],
      [3, "REJECTED", "OPENING_AFTER_MOVEMENT", [], null],
    ]);
    // The manager has no cost.view: the cost cells are blanked in what is shown.
    expect(page.rows[0]!.raw).toEqual(["4001", "", "5", "", "", "", "", "", ""]);

    // Default: the flagged row is skipped (SKIPPED_HAS_STOCK); the rest posts.
    const c = value(await commitOpeningImport({ batchId: v.batchId }, s.as("manager")));
    expect(c.stats).toMatchObject({ posted: 1, skipped: 1, skippedHasStock: 1, rejected: 1 });
    expect(c.valueMinor).toBeUndefined();
    expect(await s.onHand(a.variantId)).toBe(7n * U);
    expect(await s.onHand(b.variantId)).toBe(2n * U);
    expect((await rowsOf(v.batchId))[0]).toMatchObject({ status: "SKIPPED", reason: "SKIPPED_HAS_STOCK" });

    // includeHasStock: true posts it (an OPENING adds).
    await s.item("4005");
    const v2 = await stageAndValidate(s, csv([row({ barcode: "4001", quantity: "5", cost: "100" }), row({ barcode: "4005", quantity: "1" })]));
    expect(v2.hasStock).toEqual([{ rowNumber: 1, variantId: a.variantId, onHand: 7n * U }]);
    const c2 = value(await commitOpeningImport({ batchId: v2.batchId, includeHasStock: true }, s.as("owner")));
    expect(c2.stats).toMatchObject({ posted: 2, skippedHasStock: 0 });
    expect(await s.onHand(a.variantId)).toBe(12n * U);
  });

  it("a cashier and a stock officer without catalog.import cannot import", async () => {
    const s = await shop();
    await s.item("5001");
    const text = csv([row({ barcode: "5001", quantity: "1" })]);
    const v = await stageAndValidate(s, text, "manager");
    for (const who of ["stock", "cashier"]) {
      const results = [
        await stageOpeningImport({ fileName: "x.csv", contentBase64: b64(text) }, s.as(who)),
        await validateOpeningImport({ batchId: v.batchId, mapping: v.suggestedMapping }, s.as(who)),
        await commitOpeningImport({ batchId: v.batchId }, s.as(who)),
        await commitOpeningSlice({ batchId: v.batchId }, s.as(who)),
        await getOpeningImport({ batchId: v.batchId }, s.as(who)),
        await listOpeningImports({}, s.as(who)),
        await downloadOpeningRejected({ batchId: v.batchId }, s.as(who)),
      ];
      for (const r of results) expect(r).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    expect(await s.openingDocs()).toHaveLength(0);
    expect(value(await commitOpeningImport({ batchId: v.batchId }, s.as("manager"))).stats).toMatchObject({ posted: 1 });
    expect(value(await listOpeningImports({}, s.as("manager")))).toHaveLength(1);
  });

  it("READ_ONLY refuses every step", async () => {
    const s = await shop();
    await s.item("6001");
    const text = csv([row({ barcode: "6001", quantity: "1" })]);
    const v = await stageAndValidate(s, text);
    await db.rtBusiness.update({ where: { id: s.businessId }, data: { status: "SUSPENDED" } });
    const writes = [
      await stageOpeningImport({ fileName: "x.csv", contentBase64: b64(text) }, s.as("owner")),
      await validateOpeningImport({ batchId: v.batchId, mapping: v.suggestedMapping }, s.as("owner")),
      await commitOpeningImport({ batchId: v.batchId }, s.as("owner")),
      await commitOpeningSlice({ batchId: v.batchId }, s.as("owner")),
    ];
    for (const r of writes) expect(r).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect(await s.openingDocs()).toHaveLength(0);
    // Reads stay allowed (as in the catalog import).
    expect(value(await listOpeningImports({}, s.as("owner")))).toHaveLength(1);
    expect(value(await getOpeningImport({ batchId: v.batchId }, s.as("owner")))).toMatchObject({ status: "VALIDATED" });
  });

  it("an interrupted commit resumes the remaining slices", async () => {
    const s = await shop();
    const code = (i: number) => `77${String(i).padStart(6, "0")}`;
    await s.manyItems(700, code);
    const v = await stageAndValidate(s, csv(Array.from({ length: 700 }, (_, i) => row({ barcode: code(i), quantity: "2", cost: "10" }))));
    // Only the first slice runs, as if the server stopped after it.
    expect(value(await commitOpeningSlice({ batchId: v.batchId }, s.as("owner")))).toMatchObject({ done: false, posted: 500, rejected: 0 });
    expect(await s.openingDocs()).toHaveLength(1);
    expect(await db.rtImportBatch.findUniqueOrThrow({ where: { id: v.batchId } })).toMatchObject({ status: "VALIDATED" });
    // Re-validating now would change rows that are already posted.
    expect(await validateOpeningImport({ batchId: v.batchId, mapping: v.suggestedMapping }, s.as("owner"))).toMatchObject({
      ok: false,
      code: "IMPORT_ALREADY_COMMITTED",
    });
    const c = value(await commitOpeningImport({ batchId: v.batchId }, s.as("owner")));
    expect(c.stats).toMatchObject({ posted: 700, rejected: 0 });
    const docs = await s.openingDocs();
    expect(docs.map((d) => d._count.lines)).toEqual([500, 200]);
    expect(await s.totals()).toEqual({ qty: 1400n * U, valueMinor: 14_000n });
  }, 60_000);

  it("another business cannot read or commit the batch, and the catalog import cannot see it", async () => {
    const s = await shop("A");
    const other = await shop("B");
    await s.item("8001");
    const v = await stageAndValidate(s, csv([row({ barcode: "8001", quantity: "1" })]));
    const results = [
      await validateOpeningImport({ batchId: v.batchId, mapping: v.suggestedMapping }, other.as("owner")),
      await commitOpeningImport({ batchId: v.batchId }, other.as("owner")),
      await getOpeningImport({ batchId: v.batchId }, other.as("owner")),
      await downloadOpeningRejected({ batchId: v.batchId }, other.as("owner")),
    ];
    for (const r of results) expect(r).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(value(await listOpeningImports({}, other.as("owner")))).toHaveLength(0);
    expect(await s.openingDocs()).toHaveLength(0);

    // A catalog batch is not an opening import (and the reverse is tested with the catalog import).
    const { stageImport } = await import("@/server/catalog/import/actions");
    const catalog = value(await stageImport({ fileName: "c.csv", contentBase64: b64("الباركود,الاسم\n8002,قلم") }, s.as("owner")));
    expect(await getOpeningImport({ batchId: catalog.batchId }, s.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await commitOpeningImport({ batchId: catalog.batchId }, s.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(value(await listOpeningImports({}, s.as("owner"))).map((b) => b.id)).toEqual([v.batchId]);
  });

  it("a row whose item changed after validation is rejected at commit with its reason; the rest posts", async () => {
    const s = await shop();
    const a = await s.item("8101");
    const b = await s.item("8102");
    const c = await s.item("8103");
    const v = await stageAndValidate(s, csv([row({ barcode: "8101", quantity: "1" }), row({ barcode: "8102", quantity: "2" }), row({ barcode: "8103", quantity: "3" })]));
    expect(v.summary).toMatchObject({ ok: 3 });
    await db.rtVariant.update({ where: { id: a.variantId }, data: { archivedAt: new Date() } });
    // A receipt for c since validation: an opening is no longer allowed for it.
    await postOpening(s, [{ variantId: c.variantId, unitId: c.piece, quantity: "1", cost: { amount: "5", currency: "IQD" } }], "RECEIPT");
    const r = value(await commitOpeningImport({ batchId: v.batchId }, s.as("owner")));
    expect(r.stats).toMatchObject({ posted: 1, rejected: 2, documents: 1 });
    expect((await rowsOf(v.batchId)).map((x) => [x.status, x.reason])).toEqual([
      ["REJECTED", "ARCHIVED"],
      ["COMMITTED", "POSTED"],
      ["REJECTED", "OPENING_AFTER_MOVEMENT"],
    ]);
    expect(await s.onHand(b.variantId)).toBe(2n * U);
    expect(await s.onHand(c.variantId)).toBe(1n * U);
    // The document's line keeps the file's row number.
    const doc = (await s.openingDocs())[0]!;
    expect(await db.rtStockLine.findMany({ where: { documentId: doc.id }, select: { lineNo: true } })).toEqual([{ lineNo: 2 }]);
  });

  it("costs are shown only with cost.view and never stored in idempotency records", async () => {
    const s = await shop();
    await s.item("9001");
    const text = csv([row({ barcode: "9001", quantity: "2", cost: "123457" }), row({ barcode: "9001", quantity: "x", cost: "765432" })]);
    const v = await stageAndValidate(s, text, "manager");
    expect(v.firstRejected).toEqual([{ rowNumber: 2, reason: "BAD_QUANTITY", raw: ["9001", "", "x", "", "", "", "", "", ""] }]);
    const csvFile = value(await downloadOpeningRejected({ batchId: v.batchId }, s.as("manager")));
    expect(csvFile).not.toContain("765432");
    expect(value(await downloadOpeningRejected({ batchId: v.batchId }, s.as("owner")))).toContain("765432");
    const ownerView = value(await getOpeningImport({ batchId: v.batchId }, s.as("owner")));
    expect(ownerView.rows[0]!.raw).toContain("123457");
    const c = value(await commitOpeningImport({ batchId: v.batchId }, s.as("owner")));
    expect(c.valueMinor).toBe(246_914n);
    const idem = JSON.stringify(await db.rtIdempotency.findMany({ where: { scope: s.businessId } }), (_, x) => (typeof x === "bigint" ? x.toString() : x));
    expect(idem).not.toContain("123457");
    expect(idem).not.toContain("246914");
    expect(idem).not.toContain("765432");
  });

  it("the cost column stays hidden without cost.view, before validation and after any re-mapping", async () => {
    const s = await shop();
    await s.item("9101");
    const text = csv([row({ barcode: "9101", quantity: "2", cost: "4321" }), row({ barcode: "9101", quantity: "x", cost: "8765" })]);
    // Staged by the owner, not validated yet: the manager already sees no cost.
    const staged = await stage(s, text);
    const before = value(await getOpeningImport({ batchId: staged.batchId }, s.as("manager")));
    expect(before.rows.map((r) => r.raw[4])).toEqual(["", ""]);
    // The manager cannot un-map or move the cost column, nor read it through another field.
    for (const mapping of [{ ...staged.suggestedMapping, cost: null }, { ...staged.suggestedMapping, cost: null, batch: 4 }]) {
      expect(await validateOpeningImport({ batchId: staged.batchId, mapping }, s.as("manager"))).toMatchObject({
        ok: false,
        code: "STOCK_RULE",
        details: { reason: "COST_COLUMN_LOCKED" },
      });
    }
    // The owner may un-map it; it stays hidden from the manager in every view.
    const v = value(await validateOpeningImport({ batchId: staged.batchId, mapping: { ...staged.suggestedMapping, cost: null } }, s.as("owner")));
    expect(v.firstRejected[0]!.raw[4]).toBe("8765");
    const after = value(await getOpeningImport({ batchId: staged.batchId }, s.as("manager")));
    expect(after.rows.map((r) => r.raw[4])).toEqual(["", ""]);
    expect(value(await downloadOpeningRejected({ batchId: staged.batchId }, s.as("manager")))).not.toContain("8765");

    // A cost column the headers do not name: hidden once it was mapped as cost, also after the
    // owner un-maps it and the manager re-validates with cost: null.
    const odd = await stage(s, csv([["9101", "2", "5555"], ["9101", "y", "6666"]], ["الباركود", "الكمية", "مبلغ"]));
    expect(odd.suggestedMapping.cost).toBeNull();
    value(await validateOpeningImport({ batchId: odd.batchId, mapping: { ...odd.suggestedMapping, cost: 2 } }, s.as("owner")));
    value(await validateOpeningImport({ batchId: odd.batchId, mapping: odd.suggestedMapping }, s.as("owner")));
    const m = value(await validateOpeningImport({ batchId: odd.batchId, mapping: odd.suggestedMapping }, s.as("manager")));
    expect(m.firstRejected).toEqual([{ rowNumber: 2, reason: "BAD_QUANTITY", raw: ["9101", "y", ""] }]);
    const page = value(await getOpeningImport({ batchId: odd.batchId }, s.as("manager")));
    expect(page.rows.map((r) => r.raw[2])).toEqual(["", ""]);
    const file = value(await downloadOpeningRejected({ batchId: odd.batchId }, s.as("manager")));
    expect(file).not.toContain("6666");
    expect(value(await downloadOpeningRejected({ batchId: odd.batchId }, s.as("owner")))).toContain("6666");
  });

  it("stock that arrives after validation is not doubled by a later commit", async () => {
    const s = await shop();
    const x = await s.item("9201");
    const y = await s.item("9202");
    const z = await s.item("9203");
    const a = await stageAndValidate(s, csv([row({ barcode: "9201", quantity: "5" }), row({ barcode: "9202", quantity: "1" })]));
    const b = await stageAndValidate(s, csv([row({ barcode: "9201", quantity: "3" }), row({ barcode: "9203", quantity: "2" })]));
    const c = await stageAndValidate(s, csv([row({ barcode: "9202", quantity: "4" })]));
    for (const v of [a, b, c]) expect(v.summary.hasStock).toBe(0);
    value(await commitOpeningImport({ batchId: a.batchId }, s.as("owner")));
    // B overlaps A on x: by default that row is skipped, the rest posts.
    const rb = value(await commitOpeningImport({ batchId: b.batchId }, s.as("owner")));
    expect(rb.stats).toMatchObject({ posted: 1, skipped: 1, skippedHasStock: 1 });
    expect((await rowsOf(b.batchId)).map((r) => [r.status, r.reason])).toEqual([
      ["SKIPPED", "SKIPPED_HAS_STOCK"],
      ["COMMITTED", "POSTED"],
    ]);
    expect(await s.onHand(x.variantId)).toBe(5n * U);
    expect(await s.onHand(z.variantId)).toBe(2n * U);
    // With includeHasStock: true the overlapping row posts (an OPENING adds).
    const rc = value(await commitOpeningImport({ batchId: c.batchId, includeHasStock: true }, s.as("owner")));
    expect(rc.stats).toMatchObject({ posted: 1, skippedHasStock: 0 });
    expect(await s.onHand(y.variantId)).toBe(5n * U);
  });

  it("an earlier import of the same file that posted nothing does not block it", async () => {
    const s = await shop();
    const text = csv([row({ barcode: "9399", quantity: "1" })]);
    const first = await stageAndValidate(s, text);
    expect(value(await commitOpeningImport({ batchId: first.batchId }, s.as("owner"))).stats).toMatchObject({ posted: 0, rejected: 1 });
    await s.item("9399");
    const again = await stageAndValidate(s, text);
    expect(value(await commitOpeningImport({ batchId: again.batchId }, s.as("owner"))).stats).toMatchObject({ posted: 1 });
    // Now it posted: a third upload is refused.
    expect(await stageOpeningImport({ fileName: "x.csv", contentBase64: b64(text) }, s.as("owner"))).toMatchObject({
      ok: false,
      code: "IMPORT_SAME_FILE",
      details: { batchId: again.batchId },
    });
  });

  it("on-hand quantities are hidden from a caller who cannot reach the batch's location", async () => {
    const s = await shop();
    const a = await s.item("9401");
    await postOpening(s, [{ variantId: a.variantId, unitId: a.piece, quantity: "7" }]);
    const v = await stageAndValidate(s, csv([row({ barcode: "9401", quantity: "1" })]));
    expect(v.hasStock).toEqual([{ rowNumber: 1, variantId: a.variantId, onHand: 7n * U }]);
    flags.limitBranches = true;
    try {
      expect(value(await getOpeningImport({ batchId: v.batchId }, s.as("manager"))).rows[0]!.onHand).toBe(7n * U);
      const far = value(await getOpeningImport({ batchId: v.batchId }, s.as("far")));
      expect(far.rows[0]).toMatchObject({ reason: "HAS_STOCK", onHand: null });
    } finally {
      flags.limitBranches = false;
    }
  });
});
