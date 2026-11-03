import { parseMoneyText, toAsciiDigits } from "@/server/domain/catalog";
import type { UiCode } from "../../catalog/_lib/types";

/*
 * The till's cart, pure (no React, no storage): what the screens draw and what the sale action is
 * sent. Money is BigInt minor units in the browser and digit strings on the wire; a quantity is the
 * text typed in the line's unit, as the server parses it. The totals here use the server's rule
 * (unit price x quantity, half up), so the total the cashier sees is the total the server charges
 * (it refuses with PRICE_CHANGED otherwise).
 */

export type Currency = "IQD" | "USD";

/** One tile as the browser receives it (money and stock as digit strings). */
export type SellItemDto = {
  variantId: string;
  unitId: string;
  nameAr: string;
  nameCkb: string | null;
  nameEn: string | null;
  unitName: string;
  quantityScale: number;
  factor: number;
  soldByWeight: boolean;
  priceMinor: string | null;
  currency: Currency;
  /** Base units x 1000, null when not read. */
  onHand: string | null;
  matchedBarcode: string | null;
  /** The top-level category the tile is coloured by, or null. */
  categoryId: string | null;
};

export type CategoryDto = { id: string; nameAr: string; nameCkb: string | null; nameEn: string | null };

export type CartLine = {
  key: string;
  variantId: string;
  unitId: string;
  nameAr: string;
  nameCkb: string | null;
  nameEn: string | null;
  unitName: string;
  quantityScale: number;
  priceMinor: bigint;
  /** As typed, ASCII digits ("2", "0.75"). */
  quantity: string;
};

export type SellResult<T> = { ok: true; value: T } | { ok: false; code: UiCode; details?: Readonly<Record<string, string | null>> };

export type ShiftDto = {
  id: string;
  version: number;
  openedAt: string;
  currency: Currency;
  openingCashMinor: string;
  salesCount: number;
  totalMinor: string;
  cashMinor: string;
  cardMinor: string;
  expectedCashMinor: string;
};

export type ReceiptDto = {
  saleId: string;
  number: number;
  saleKey: string;
  currency: Currency;
  totalMinor: string;
  paidMinor: string;
  changeMinor: string;
  postedAt: string;
  lines: { lineNo: number; nameAr: string; nameCkb: string | null; nameEn: string | null; unitName: string; quantity: string; unitPriceMinor: string; lineTotalMinor: string }[];
  payments: { method: "CASH" | "CARD"; amountMinor: string; tenderedMinor: string }[];
};

export const lineKey = (variantId: string, unitId: string) => `${variantId}:${unitId}`;

/** A quantity as an integer scaled by 10^scale, or null when the text is not a positive quantity the unit can hold. */
export function scaledQuantity(text: string, scale: number): bigint | null {
  const m = /^(\d{1,13})(?:[.٫](\d+))?$/.exec(toAsciiDigits(text).trim());
  if (!m) return null;
  const frac = m[2] ?? "";
  if (/[^0]/.test(frac.slice(scale))) return null;
  const v = BigInt(m[1]! + frac.slice(0, scale).padEnd(scale, "0"));
  return v > 0n ? v : null;
}

/** The server's line total: price x quantity, half up. 0 for a quantity that does not parse. */
export function lineTotal(line: Pick<CartLine, "priceMinor" | "quantity" | "quantityScale">): bigint {
  const q = scaledQuantity(line.quantity, line.quantityScale);
  if (q === null) return 0n;
  const d = 10n ** BigInt(line.quantityScale);
  return (line.priceMinor * q * 2n + d) / (d * 2n);
}

export function cartTotal(lines: readonly CartLine[]): bigint {
  return lines.reduce((s, l) => s + lineTotal(l), 0n);
}

/** Pieces in the cart (a weighed line counts once). */
export function cartCount(lines: readonly CartLine[]): number {
  return lines.reduce((s, l) => s + (l.quantityScale === 0 ? Number(scaledQuantity(l.quantity, 0) ?? 0n) : 1), 0);
}

/** Can this tile be added? An item without a price cannot. */
export const sellable = (item: SellItemDto) => item.priceMinor !== null;

/** Adds one of the item's unit (or `quantity` for a weighed item), merging with its line. */
export function addItem(lines: readonly CartLine[], item: SellItemDto, quantity = "1"): CartLine[] {
  if (item.priceMinor === null) return [...lines];
  const key = lineKey(item.variantId, item.unitId);
  const found = lines.find((l) => l.key === key);
  if (found) return lines.map((l) => (l.key === key ? { ...l, quantity: addQuantity(l.quantity, quantity, l.quantityScale) } : l));
  return [
    ...lines,
    {
      key,
      variantId: item.variantId,
      unitId: item.unitId,
      nameAr: item.nameAr,
      nameCkb: item.nameCkb,
      nameEn: item.nameEn,
      unitName: item.unitName,
      quantityScale: item.quantityScale,
      priceMinor: BigInt(item.priceMinor),
      quantity: normalizeQuantity(quantity, item.quantityScale) ?? "1",
    },
  ];
}

function formatScaled(v: bigint, scale: number): string {
  if (scale === 0) return v.toString();
  const d = 10n ** BigInt(scale);
  const frac = (v % d).toString().padStart(scale, "0").replace(/0+$/, "");
  return frac ? `${v / d}.${frac}` : `${v / d}`;
}

/** The quantity in plain ASCII form ("٠٫٥" -> "0.5"), or null when it is not valid for the unit. */
export function normalizeQuantity(text: string, scale: number): string | null {
  const v = scaledQuantity(text, scale);
  return v === null ? null : formatScaled(v, scale);
}

function addQuantity(a: string, b: string, scale: number): string {
  const x = scaledQuantity(a, scale) ?? 0n;
  const y = scaledQuantity(b, scale) ?? 0n;
  return formatScaled(x + y, scale);
}

/** +1 / -1 of the line's unit; a line that would reach 0 or less is removed. */
export function stepLine(lines: readonly CartLine[], key: string, delta: 1 | -1): CartLine[] {
  return lines.flatMap((l) => {
    if (l.key !== key) return [l];
    const one = 10n ** BigInt(l.quantityScale);
    const next = (scaledQuantity(l.quantity, l.quantityScale) ?? 0n) + (delta === 1 ? one : -one);
    return next > 0n ? [{ ...l, quantity: formatScaled(next, l.quantityScale) }] : [];
  });
}

/** Sets a typed quantity; refuses (returns null) a quantity the unit cannot hold. */
export function setQuantity(lines: readonly CartLine[], key: string, text: string): CartLine[] | null {
  const line = lines.find((l) => l.key === key);
  if (!line) return null;
  const q = normalizeQuantity(text, line.quantityScale);
  if (q === null) return null;
  return lines.map((l) => (l.key === key ? { ...l, quantity: q } : l));
}

export const removeLine = (lines: readonly CartLine[], key: string) => lines.filter((l) => l.key !== key);

/** New prices (after PRICE_CHANGED); a unit that lost its price drops out of the cart. */
export function repriceLines(lines: readonly CartLine[], prices: Readonly<Record<string, string | null>>): CartLine[] {
  return lines.flatMap((l) => {
    const p = prices[l.unitId];
    if (p === undefined) return [l];
    return p === null ? [] : [{ ...l, priceMinor: BigInt(p) }];
  });
}

// ---------------------------------------------------------------------------------------------
// Paying

/**
 * The buttons of the pay screen: the exact amount first, then the notes a customer is likely to
 * hand over (rounded up, then the common large notes), each at least the amount due.
 */
export function quickAmounts(due: bigint, currency: Currency): bigint[] {
  const up = (step: bigint) => (due <= 0n ? step : ((due + step - 1n) / step) * step);
  const notes = currency === "IQD" ? [5_000n, 10_000n, 25_000n, 50_000n, 100_000n] : [500n, 1_000n, 2_000n, 5_000n, 10_000n];
  const steps = currency === "IQD" ? [1_000n, 5_000n, 10_000n, 25_000n] : [100n, 500n, 1_000n, 2_500n];
  const set = new Set<bigint>([due, ...steps.map(up), ...notes].filter((v) => v >= due && v > 0n));
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 6);
}

export type Tender = { cashMinor: bigint; cardMinor: bigint };

export type PayState = {
  due: bigint;
  paid: bigint;
  /** What is still owed (0 when covered). */
  remaining: bigint;
  change: bigint;
  /** The payment can be sent: covered, card not above the total, no cash beyond what change needs. */
  ready: boolean;
};

export function payState(due: bigint, t: Tender): PayState {
  const paid = t.cashMinor + t.cardMinor;
  const remaining = paid >= due ? 0n : due - paid;
  const change = paid > due ? paid - due : 0n;
  const ready = paid >= due && t.cardMinor <= due && !(t.cashMinor > 0n && t.cardMinor === due && due > 0n);
  return { due, paid, remaining, change, ready };
}

/** A note tapped: added to the cash handed over. */
export const addCash = (t: Tender, amount: bigint): Tender => ({ ...t, cashMinor: t.cashMinor + amount });
/** "Exact": cash covers exactly what the card does not. */
export const exactCash = (due: bigint, t: Tender): Tender => ({ ...t, cashMinor: due > t.cardMinor ? due - t.cardMinor : 0n });
/** Card pays what cash does not cover (all of it when no cash was given). */
export function cardRest(due: bigint, t: Tender): Tender {
  if (t.cashMinor >= due) return { cashMinor: 0n, cardMinor: due };
  return { cashMinor: t.cashMinor, cardMinor: due - t.cashMinor };
}

/** The payments as the sale action takes them. */
export function paymentsOf(t: Tender): { method: "CASH" | "CARD"; amountMinor: string }[] {
  const out: { method: "CASH" | "CARD"; amountMinor: string }[] = [];
  if (t.cashMinor > 0n) out.push({ method: "CASH", amountMinor: t.cashMinor.toString() });
  if (t.cardMinor > 0n) out.push({ method: "CARD", amountMinor: t.cardMinor.toString() });
  return out;
}

/** A typed amount (Arabic digits and separators accepted) in minor units, or null. */
export function parseAmount(text: string, currency: Currency): bigint | null {
  try {
    const v = parseMoneyText(text, currency);
    return v >= 0n ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Held carts (this device only)

export type HeldCart = { id: string; at: string; lines: { key: string; variantId: string; unitId: string; nameAr: string; nameCkb: string | null; nameEn: string | null; unitName: string; quantityScale: number; priceMinor: string; quantity: string }[] };

export const MAX_HELD = 10;

export function holdCart(held: readonly HeldCart[], lines: readonly CartLine[], id: string, at: Date): HeldCart[] {
  if (lines.length === 0) return [...held];
  const entry: HeldCart = { id, at: at.toISOString(), lines: lines.map((l) => ({ ...l, priceMinor: l.priceMinor.toString() })) };
  return [entry, ...held].slice(0, MAX_HELD);
}

export function resumeCart(held: readonly HeldCart[], id: string): { lines: CartLine[]; held: HeldCart[] } | null {
  const entry = held.find((h) => h.id === id);
  if (!entry) return null;
  return { lines: entry.lines.map((l) => ({ ...l, priceMinor: BigInt(l.priceMinor) })), held: held.filter((h) => h.id !== id) };
}

/** Held carts read back from storage: anything malformed is dropped, never trusted. */
export function parseHeld(raw: string | null): HeldCart[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((h): h is HeldCart => {
        if (typeof h !== "object" || h === null) return false;
        const e = h as HeldCart;
        return typeof e.id === "string" && typeof e.at === "string" && Array.isArray(e.lines) && e.lines.every((l) => typeof l?.unitId === "string" && /^\d+$/.test(String(l?.priceMinor)) && typeof l?.quantity === "string");
      })
      .slice(0, MAX_HELD);
  } catch {
    return [];
  }
}
