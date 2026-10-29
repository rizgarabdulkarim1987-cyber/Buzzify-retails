// Pure stock rules. No framework or database imports.
// Quantity: BigInt in the base unit x QTY_SCALE. Money: BigInt minor units. All rounding half up.
import type { Currency } from "@/generated/prisma/enums";
import { RuleError } from "@/server/framework/errors";
import { toAsciiDigits } from "./catalog";

export const QTY_SCALE = 1000n;
/** 10^12 base units, scaled. */
export const MAX_BASE_QTY = 1_000_000_000_000n * QTY_SCALE;
export const STOCK_REASONS = ["DAMAGED", "EXPIRED", "LOST", "COUNT_FIX", "OTHER"] as const;
export type StockReason = (typeof STOCK_REASONS)[number];

const RATE_SCALE = 1_000_000n;
const MAX_RATE_INT_DIGITS = 9;
const MAX_QTY_INT_DIGITS = 13;
/** Same cap as the catalog price limit (10^18 minor units); local so the domain stays layer-free. */
const MAX_VALUE_MINOR = 10n ** 18n;

type QtyUnit = { factor: number; quantityScale: number };

function invalid(): never {
  throw new RuleError("INVALID_INPUT");
}

/** Round-half-up division of non-negative-or-negative integers (ties go away from zero). */
function divRound(n: bigint, d: bigint): bigint {
  if (d <= 0n) invalid();
  if (n < 0n) return -divRound(-n, d);
  return (n * 2n + d) / (d * 2n);
}

function capValue(v: bigint): bigint {
  if (v > MAX_VALUE_MINOR) invalid();
  return v;
}

function normalizeNumber(text: string): string {
  return toAsciiDigits(text).trim().replace(/٬/g, ",").replace(/٫/g, ".");
}

/** Typed quantity as an integer scaled by 10^quantityScale (positive only). */
function parseTypedQty(text: string, quantityScale: number): bigint {
  if (!Number.isInteger(quantityScale) || quantityScale < 0 || quantityScale > 3) invalid();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(normalizeNumber(text));
  if (!m) invalid();
  const frac = m[2] ?? "";
  if (m[1].replace(/^0+/, "").length > MAX_QTY_INT_DIGITS) invalid();
  if (/[^0]/.test(frac.slice(quantityScale))) invalid();
  const scaled = BigInt(m[1] + frac.slice(0, quantityScale).padEnd(quantityScale, "0"));
  if (scaled <= 0n) invalid();
  return scaled;
}

function assertFactor(factor: number): bigint {
  if (!Number.isInteger(factor) || factor < 1) invalid();
  return BigInt(factor);
}

/** Quantity typed in `unit` to the base unit x 1000. Refuses zero, negatives, extra decimals, overflow. */
export function toBaseQty(text: string, unit: QtyUnit): bigint {
  const scaled = parseTypedQty(text, unit.quantityScale);
  const base = (scaled * assertFactor(unit.factor) * QTY_SCALE) / 10n ** BigInt(unit.quantityScale);
  if (base > MAX_BASE_QTY) invalid();
  return base;
}

/**
 * Break a base quantity into whole units, largest first. Zero-count parts are omitted;
 * `remainder` is what is left (base x 1000, 0n when exact), e.g. 500 for half a kilo.
 */
export function splitIntoUnits(
  baseQty: bigint,
  units: { name: string; factor: number }[],
): { parts: { name: string; count: bigint }[]; remainder: bigint } {
  const sorted = [...units].sort((a, b) => b.factor - a.factor);
  let rest = baseQty;
  const parts: { name: string; count: bigint }[] = [];
  for (const u of sorted) {
    const size = assertFactor(u.factor) * QTY_SCALE;
    const count = rest / size;
    if (count > 0n) {
      parts.push({ name: u.name, count });
      rest -= count * size;
    }
  }
  return { parts, remainder: rest };
}

/** IQD per 1 USD as text, to an integer x 10^6 (at most 6 decimals, above zero). */
export function parseRate(text: string): bigint {
  const m = /^((?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.(\d+))?$/.exec(normalizeNumber(text));
  if (!m) invalid();
  const frac = m[2] ?? "";
  const intPart = m[1].replace(/,/g, "");
  if (frac.length > 6 || intPart.replace(/^0+/, "").length > MAX_RATE_INT_DIGITS) invalid();
  const v = BigInt(intPart) * RATE_SCALE + BigInt(frac.padEnd(6, "0"));
  if (v <= 0n) invalid();
  return v;
}

/** Convert minor units between currencies. rateMicro = IQD per 1 USD x 10^6. Half up. */
export function convertMinor(amount: bigint, from: Currency, to: Currency, rateMicro: bigint | null): bigint {
  if (from === to) return amount;
  if (rateMicro === null || rateMicro <= 0n) invalid();
  // IQD has 0 minor digits, USD has 2: 1 USD cent = rate / 100 IQD.
  if (from === "IQD" && to === "USD") return divRound(amount * 100n * RATE_SCALE, rateMicro);
  if (from === "USD" && to === "IQD") return divRound(amount * rateMicro, 100n * RATE_SCALE);
  return invalid();
}

/** Value of a line: cost per typed unit x typed quantity, half up. */
export function lineValueMinor(unitCostMinor: bigint, text: string, unit: QtyUnit): bigint {
  const scaled = parseTypedQty(text, unit.quantityScale);
  return capValue(divRound(unitCostMinor * scaled, 10n ** BigInt(unit.quantityScale)));
}

/** Value leaving with `outQty` of `onHandQty`: proportional; the final outflow takes all that remains. */
export function reduceValue(onHandQty: bigint, onHandValue: bigint, outQty: bigint): bigint {
  if (onHandQty < 0n || onHandValue < 0n || outQty < 0n || outQty > onHandQty) invalid();
  if (outQty === 0n) return 0n;
  if (outQty === onHandQty) return onHandValue;
  return divRound(onHandValue * outQty, onHandQty);
}

/** Cost of one unit with `factor` base units, from a quantity (base x 1000) and its value. */
export function unitCostMinor(qty: bigint, value: bigint, factor: number): bigint {
  if (qty === 0n) return 0n;
  return capValue(divRound(value * assertFactor(factor) * QTY_SCALE, qty));
}

const DAY_MS = 86_400_000;
const utcDay = (d: Date) => Math.floor(d.getTime() / DAY_MS);

/**
 * Today's calendar day in `timeZone` (IANA name), as a date-only value: the UTC-midnight Date of
 * that local day. Use it to build the `today` that expiryStatus expects.
 */
export function businessToday(now: Date, timeZone: string): Date {
  if (Number.isNaN(now.getTime())) invalid();
  let text: string;
  try {
    text = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return invalid();
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) invalid();
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/**
 * `expiry` and `today` are date-only values represented as UTC-midnight Dates (the time of day
 * is ignored). The caller computes `today` in the business time zone (see businessToday).
 * An expiry equal to today is SOON, not EXPIRED.
 */
export function expiryStatus(
  expiry: Date | null,
  today: Date,
  alertDays: number,
): "NONE" | "OK" | "SOON" | "EXPIRED" {
  if (Number.isNaN(today.getTime()) || (expiry !== null && Number.isNaN(expiry.getTime()))) invalid();
  if (!Number.isInteger(alertDays) || alertDays < 0) invalid();
  if (expiry === null) return "NONE";
  const left = utcDay(expiry) - utcDay(today);
  if (left < 0) return "EXPIRED";
  return left <= alertDays ? "SOON" : "OK";
}
