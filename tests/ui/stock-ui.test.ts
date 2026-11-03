import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ar } from "@/messages/ar";
import { ckb } from "@/messages/ckb";
import { en } from "@/messages/en";
import { ERROR_MESSAGES } from "@/server/framework/errors";
import { RefusedPage } from "../../src/app/retail/catalog/_lib/state-pages";
import { batchChoices, checkAdjustForm, reasonsFor, stockFailureMessage } from "../../src/app/retail/stock/_lib/adjust-rules";
import { breakdownText, formatQty, movementDto, stockRowDto } from "../../src/app/retail/stock/_lib/format";
import type { MovementDto, StockRowDto } from "../../src/app/retail/stock/_lib/types";
import { ExpiringTable, MovementTable, ReadOnlyBanner, StockList, StockListEmpty, StockSkeleton } from "../../src/app/retail/stock/_lib/views";

const html = (el: ReactElement) => renderToStaticMarkup(el);

const row = (over: Partial<StockRowDto> = {}): StockRowDto => ({
  productId: "p1",
  variantId: "v1",
  nameAr: "سكر",
  sku: "P-1",
  qty: "40000",
  availableQty: "40000",
  breakdown: { parts: [{ name: "كرتون", count: "3" }, { name: "قطعة", count: "4" }], remainder: "0" },
  nearestExpiry: null,
  status: "NONE",
  ...over,
});

describe("stock list", () => {
  it("the stock list renders cartons and pieces and hides cost without cost.view", () => {
    // The server leaves the value keys out for a caller without cost.view; the wire copy must not add them.
    const plain = stockRowDto({
      productId: "p1",
      variantId: "v1",
      nameAr: "سكر",
      sku: "P-1",
      qty: 40000n,
      availableQty: 40000n,
      breakdown: { parts: [{ name: "كرتون", count: 3n }, { name: "قطعة", count: 4n }], remainder: 0n },
      nearestExpiry: null,
      status: "NONE",
    });
    expect("valueMinor" in plain).toBe(false);
    expect("avgUnitCostMinor" in plain).toBe(false);
    expect(plain.breakdown.parts[0]).toEqual({ name: "كرتون", count: "3" });

    const props = { locale: "ar" as const, t: ar, currency: "IQD" as const, canAdjust: false, adjustDisabled: false, onAdjust: undefined };
    const noCost = html(createElement(StockList, { ...props, rows: [row()], canSeeCost: false }));
    expect(noCost).toContain("٣ كرتون");
    expect(noCost).toContain("٤ قطعة");
    expect(noCost).not.toContain('data-testid="stock-value"');
    expect(noCost).not.toContain(ar.stock.list.value);
    expect(noCost).not.toContain('data-testid="stock-adjust"');

    const withCost = html(createElement(StockList, { ...props, rows: [row({ valueMinor: "125000", avgUnitCostMinor: "3125" })], canSeeCost: true }));
    expect(withCost).toContain('data-testid="stock-value"');
    expect(withCost).toContain("١٢٥٬٠٠٠ د.ع");

    // Expired stock is on hand but not available; the badge says so; a fraction of the base unit is shown.
    const expired = html(
      createElement(StockList, {
        ...props,
        locale: "en",
        t: en,
        canSeeCost: false,
        canAdjust: true,
        rows: [row({ availableQty: "1500", status: "EXPIRED", breakdown: { parts: [{ name: "Box", count: "3" }], remainder: "500" } })],
      }),
    );
    expect(expired).toContain(en.stock.badge.EXPIRED);
    expect(expired).toContain("1.5");
    expect(expired).toContain("0.5");
    expect(expired).toContain('data-testid="stock-adjust"');
    expect(html(createElement(StockList, { ...props, canSeeCost: false, rows: [row({ status: "SOON" })] }))).toContain(ar.stock.badge.SOON);
    // An archived item that still holds stock carries the catalog's "archived" badge.
    expect(html(createElement(StockList, { ...props, canSeeCost: false, rows: [row({ archived: true })] }))).toContain('data-testid="stock-badge-archived"');
    expect(html(createElement(StockList, { ...props, canSeeCost: false, rows: [row()] }))).not.toContain("stock-badge-archived");
  });

  it("names follow the interface language and fall back to Arabic", () => {
    const props = { currency: "IQD" as const, canSeeCost: false, canAdjust: true, adjustDisabled: false, onAdjust: undefined };
    const named = row({ nameCkb: "شیر", nameEn: "Milk" });
    expect(html(createElement(StockList, { ...props, locale: "ckb", t: ckb, rows: [named] }))).toContain(">شیر<");
    const en1 = html(createElement(StockList, { ...props, locale: "en", t: en, rows: [named] }));
    expect(en1).toContain(">Milk<");
    expect(en1).toContain('aria-label="Adjust stock of Milk"');
    expect(html(createElement(StockList, { ...props, locale: "en", t: en, rows: [row()] }))).toContain(">سكر<");
    const expiring = {
      productId: "p1",
      variantId: "v1",
      nameAr: "حليب",
      nameCkb: null,
      nameEn: "Milk",
      sku: "P-1",
      batchId: "b1",
      code: "L1",
      expiry: "2026-11-02T00:00:00.000Z",
      daysLeft: 3,
      status: "SOON" as const,
      qty: "2000",
      breakdown: { parts: [{ name: "Box", count: "2" }], remainder: "0" },
    };
    expect(html(createElement(ExpiringTable, { locale: "en", t: en, rows: [expiring] }))).toContain(">Milk<");
    expect(html(createElement(ExpiringTable, { locale: "ckb", t: ckb, rows: [expiring] }))).toContain(">حليب<");
  });

  it("while quantities refresh the adjust button keeps focus (aria-disabled, not disabled)", () => {
    // A disabled button cannot take back the focus the closing dialog returns to it; it would land on the body.
    const out = html(
      createElement(StockList, { locale: "ar", t: ar, currency: "IQD", canSeeCost: false, canAdjust: true, adjustDisabled: false, adjustWaiting: true, onAdjust: () => {}, rows: [row()] }),
    );
    expect(out).toMatch(/<button[^>]*aria-disabled="true"[^>]*data-testid="stock-adjust"/);
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="stock-adjust"/);
  });

  it("quantities are exact in the interface digits", () => {
    expect(formatQty("ar", "1500")).toBe("١٫٥");
    expect(formatQty("en", "1234567250")).toBe("1,234,567.25");
    expect(formatQty("en", "0")).toBe("0");
    expect(formatQty("en", "-2000")).toBe("-2");
    expect(breakdownText("en", en, { parts: [], remainder: "0" })).toBe("0");
    expect(breakdownText("en", en, { parts: [{ name: "Box", count: "2" }], remainder: "250" })).toContain("0.25");
  });
});

describe("adjust dialog rules", () => {
  it("the adjust dialog requires a reason and a note for OTHER", () => {
    const base = { mode: "OUT" as const, unitId: "u1", quantity: "2", batch: { needed: false, chosen: null }, reason: "", note: "" };
    expect(checkAdjustForm(base)).toContain("REASON_REQUIRED");
    expect(checkAdjustForm({ ...base, reason: "OTHER" })).toEqual(["NOTE_REQUIRED"]);
    expect(checkAdjustForm({ ...base, reason: "OTHER", note: "   " })).toEqual(["NOTE_REQUIRED"]);
    expect(checkAdjustForm({ ...base, reason: "OTHER", note: "counted twice" })).toEqual([]);
    expect(checkAdjustForm({ ...base, reason: "LOST" })).toEqual([]);
    // A reason of another kind of document is not accepted (write-off reasons are their own list).
    expect(checkAdjustForm({ ...base, reason: "DAMAGED" })).toContain("REASON_REQUIRED");
    expect(checkAdjustForm({ ...base, mode: "WRITE_OFF", reason: "DAMAGED" })).toEqual([]);
    expect(checkAdjustForm({ ...base, reason: "LOST", quantity: "" })).toEqual(["QUANTITY_REQUIRED"]);
    expect(checkAdjustForm({ ...base, reason: "LOST", unitId: "" })).toEqual(["UNIT_REQUIRED"]);
    expect(checkAdjustForm({ ...base, reason: "LOST", batch: { needed: true, chosen: null } })).toEqual(["BATCH_REQUIRED"]);
    expect(reasonsFor("WRITE_OFF")).toEqual(["DAMAGED", "EXPIRED", "OTHER"]);
    expect(reasonsFor("OUT")).toEqual(["LOST", "COUNT_FIX", "OTHER"]);
    expect(reasonsFor("IN")).toEqual(["COUNT_FIX", "OTHER"]);
  });

  it("an IN can go back into a used-up batch of an item that tracks expiry; taking out cannot", () => {
    const depleted = {
      trackingMode: "BATCH" as const,
      tracksExpiry: true,
      batches: [{ batchId: "b1", code: "L1", expiry: "2026-12-01T00:00:00.000Z", status: "OK" as const, qty: "0" }],
    };
    const into = batchChoices(depleted, "IN");
    expect(into).toMatchObject({ show: true, needed: true, allowNone: false, blocked: false });
    expect(into.batches.map((b) => b.batchId)).toEqual(["b1"]);
    expect(batchChoices(depleted, "OUT")).toMatchObject({ blocked: true, batches: [] });
    expect(batchChoices(depleted, "WRITE_OFF").blocked).toBe(true);
    // A batch product without expiry offers the no-batch row; a plain product shows no picker.
    const loose = { trackingMode: "BATCH" as const, tracksExpiry: false, batches: [{ batchId: null, code: null, expiry: null, status: "NONE" as const, qty: "5000" }] };
    expect(batchChoices(loose, "OUT")).toMatchObject({ show: false, allowNone: true, blocked: false });
    expect(batchChoices({ trackingMode: "NONE", tracksExpiry: false, batches: [] }, "IN")).toMatchObject({ show: false, blocked: false });
  });

  it("refusals read in the interface language, with the stock rule's own reason when it has one", () => {
    for (const t of [ar, ckb, en]) {
      for (const code of Object.keys(ERROR_MESSAGES) as (keyof typeof ERROR_MESSAGES)[]) {
        if (code === "STOCK_RULE") continue;
        expect(stockFailureMessage(t, { code })).toBe(t.errors[code]);
      }
      expect(stockFailureMessage(t, { code: "STOCK_RULE", details: { reason: "BATCH_REQUIRED", lineNo: "1" } })).toBe(t.stock.ruleReasons.BATCH_REQUIRED);
      expect(stockFailureMessage(t, { code: "STOCK_RULE", details: { reason: "SOMETHING_NEW" } })).toBe(t.errors.STOCK_RULE);
      expect(stockFailureMessage(t, { code: "INTERNAL" })).toBe(t.internalError);
      expect(stockFailureMessage(t, { code: "BAD_QUANTITY" })).toBe(t.stock.adjust.problems.BAD_QUANTITY);
    }
  });
});

/** Every leaf path of a message tree, sorted. */
function leafKeys(tree: unknown, prefix = ""): string[] {
  if (typeof tree !== "object" || tree === null) return [prefix];
  return Object.entries(tree)
    .flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k))
    .sort();
}

describe("stock messages", () => {
  it("every new message key exists in ar, ckb and en", () => {
    const keys = leafKeys(ar.stock);
    expect(keys.length).toBeGreaterThan(60);
    expect(leafKeys(ckb.stock)).toEqual(keys);
    expect(leafKeys(en.stock)).toEqual(keys);
    for (const t of [ar, ckb, en]) {
      for (const k of ["OPENING", "RECEIPT", "ADJUSTMENT", "WRITE_OFF", "REVERSAL", "SALE"] as const) expect(t.stock.movement.kinds[k].trim()).not.toBe("");
      for (const r of ["DAMAGED", "EXPIRED", "LOST", "COUNT_FIX", "OTHER"] as const) expect(t.stock.adjust.reasons[r].trim()).not.toBe("");
      for (const leaf of leafKeys(t.stock)) {
        const value = leaf.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], t.stock);
        expect(typeof value).toBe("string");
        expect((value as string).trim()).not.toBe("");
      }
    }
    expect(en.stock.title).not.toBe(ar.stock.title);
    expect(ckb.stock.adjust.title).not.toBe(ar.stock.adjust.title);
  });
});

describe("stock screen states", () => {
  it("empty, loading, forbidden and READ_ONLY states render", () => {
    const empty = html(createElement(StockListEmpty, { t: ar, filtered: false }));
    expect(empty).toContain('data-testid="stock-empty"');
    expect(empty).toContain(ar.stock.list.emptyTitle);
    expect(html(createElement(StockListEmpty, { t: ar, filtered: true }))).toContain('data-testid="stock-no-results"');

    const loading = html(createElement(StockSkeleton, { label: ar.common.loading }));
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain(ar.common.loading);

    expect(html(createElement(RefusedPage, { code: "FORBIDDEN", t: ar }))).toContain('data-testid="state-forbidden"');
    expect(html(createElement(RefusedPage, { code: "READ_ONLY", t: ar }))).toContain('data-testid="state-closed"');

    const banner = html(createElement(ReadOnlyBanner, { t: ckb }));
    expect(banner).toContain('data-testid="stock-read-only"');
    expect(banner).toContain(ckb.stock.readOnlyTitle);

    // READ_ONLY: the adjust button is drawn but disabled.
    const rows = html(
      createElement(StockList, { locale: "ar", t: ar, currency: "IQD", canSeeCost: false, canAdjust: true, adjustDisabled: true, onAdjust: undefined, rows: [row()] }),
    );
    expect(rows).toMatch(/<button[^>]*disabled=""[^>]*data-testid="stock-adjust"/);
  });
});

describe("movement page", () => {
  it("the movement page shows a running balance", () => {
    const wire = movementDto({
      id: "m2",
      createdAt: new Date("2026-10-30T09:00:00Z"),
      documentId: "d2",
      documentKind: "WRITE_OFF",
      documentNumber: 7,
      locationId: "l1",
      batchId: null,
      batchCode: null,
      qtyDelta: -2000n,
      qtyAfter: 10000n,
    });
    expect("valueAfterMinor" in wire).toBe(false);
    expect(wire.qtyAfter).toBe("10000");

    const rows: MovementDto[] = [
      wire,
      { id: "m1", createdAt: "2026-10-29T09:00:00.000Z", documentKind: "RECEIPT", documentNumber: 3, batchCode: "L-1", qtyDelta: "12000", qtyAfter: "12000" },
    ];
    const out = html(createElement(MovementTable, { locale: "en", t: en, currency: "IQD", canSeeCost: false, rows }));
    const balances = [...out.matchAll(/data-testid="movement-balance"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(balances).toEqual(["10", "12"]);
    const changes = [...out.matchAll(/data-testid="movement-change"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(changes).toEqual(["−2", "+12"]);
    expect(out).toContain(en.stock.movement.kinds.WRITE_OFF);
    expect(out).toContain("L-1");
    expect(out).not.toContain('data-testid="movement-value"');

    const withCost = html(
      createElement(MovementTable, {
        locale: "ar",
        t: ar,
        currency: "IQD",
        canSeeCost: true,
        rows: [{ ...rows[1]!, valueDeltaMinor: "60000", valueAfterMinor: "60000" }],
      }),
    );
    expect(withCost).toContain('data-testid="movement-value"');
    expect(withCost).toContain("٦٠٬٠٠٠ د.ع");
    expect(withCost).toContain("١٢");
  });
});
