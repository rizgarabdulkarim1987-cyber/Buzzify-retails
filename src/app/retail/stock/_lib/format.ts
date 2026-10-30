import { formatNumber, type Locale, type Messages } from "@/messages";
import type { ExpiringRow, MovementRow, StockRow, VariantBatch } from "@/server/stock/queries";
import { fill } from "../../../_lib/format";
import type { BatchDto, BreakdownDto, MovementDto, StockRowDto } from "./types";

/*
 * Turning the stock reads into what the browser receives (BigInt to digit strings, Date to ISO),
 * and quantities into text. A value key is copied only when the server returned it: without
 * cost.view it does not exist, and the copy must not create it (not even as undefined).
 */

const DECIMAL_MARK: Record<Locale, string> = { ar: "٫", ckb: "٫", en: "." };
const SCALE = 1000n;

type Breakdown = StockRow["breakdown"];

export function breakdownDto(b: Breakdown): BreakdownDto {
  return { parts: b.parts.map((p) => ({ name: p.name, count: p.count.toString() })), remainder: b.remainder.toString() };
}

export function stockRowDto(r: StockRow): StockRowDto {
  return {
    productId: r.productId,
    variantId: r.variantId,
    nameAr: r.nameAr,
    sku: r.sku,
    qty: r.qty.toString(),
    availableQty: r.availableQty.toString(),
    breakdown: breakdownDto(r.breakdown),
    nearestExpiry: r.nearestExpiry ? r.nearestExpiry.toISOString() : null,
    status: r.status,
    ...(r.valueMinor !== undefined ? { valueMinor: r.valueMinor.toString() } : {}),
    ...(r.avgUnitCostMinor !== undefined ? { avgUnitCostMinor: r.avgUnitCostMinor.toString() } : {}),
  };
}

export function movementDto(m: MovementRow): MovementDto {
  return {
    id: m.id,
    createdAt: m.createdAt.toISOString(),
    documentKind: m.documentKind,
    documentNumber: m.documentNumber,
    batchCode: m.batchCode,
    qtyDelta: m.qtyDelta.toString(),
    qtyAfter: m.qtyAfter.toString(),
    ...(m.valueDeltaMinor !== undefined ? { valueDeltaMinor: m.valueDeltaMinor.toString() } : {}),
    ...(m.valueAfterMinor !== undefined ? { valueAfterMinor: m.valueAfterMinor.toString() } : {}),
  };
}

export function batchDto(b: VariantBatch): BatchDto {
  return { batchId: b.batchId, code: b.code, expiry: b.expiry ? b.expiry.toISOString() : null, status: b.status, qty: b.qty.toString() };
}

export type ExpiringDto = Omit<ExpiringRow, "expiry" | "qty" | "breakdown"> & { expiry: string; qty: string; breakdown: BreakdownDto };

export function expiringDto(r: ExpiringRow): ExpiringDto {
  return { ...r, expiry: r.expiry.toISOString(), qty: r.qty.toString(), breakdown: breakdownDto(r.breakdown) };
}

/** Each digit of a plain digit string in the interface's digits. */
function localDigits(locale: Locale, digits: string): string {
  return [...digits].map((d) => formatNumber(locale, Number(d))).join("");
}

/**
 * A quantity in base units x 1000 as a number of base units, exact (BigInt only), in the
 * interface's digits and grouping: "1500" is 1.5 (١٫٥ in Arabic), trailing zeros dropped.
 */
export function formatQty(locale: Locale, scaled: string | bigint): string {
  const q = typeof scaled === "bigint" ? scaled : BigInt(scaled);
  const negative = q < 0n;
  const abs = negative ? -q : q;
  const whole = formatNumber(locale, abs / SCALE);
  const frac = (abs % SCALE).toString().padStart(3, "0").replace(/0+$/, "");
  const text = frac ? `${whole}${DECIMAL_MARK[locale]}${localDigits(locale, frac)}` : whole;
  return negative ? `-${text}` : text;
}

/** A movement's change with its sign always shown: "+12", "−2" (a true minus sign). */
export function signedQty(locale: Locale, scaled: string): string {
  const q = BigInt(scaled);
  return q < 0n ? `−${formatQty(locale, -q)}` : `+${formatQty(locale, q)}`;
}

/** "3 Box + 4 Piece", with what is left under one base unit at the end; "0" for nothing. */
export function breakdownText(locale: Locale, t: Messages, b: BreakdownDto): string {
  const parts = b.parts.map((p) => `${formatNumber(locale, BigInt(p.count))} ${p.name}`);
  if (BigInt(b.remainder) > 0n) parts.push(fill(t.stock.qty.remainder, { qty: formatQty(locale, b.remainder) }));
  return parts.length > 0 ? parts.join(" + ") : formatNumber(locale, 0);
}
