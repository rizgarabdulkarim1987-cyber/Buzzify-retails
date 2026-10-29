import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import type { RtPriceListKind } from "@/generated/prisma/enums";
import { suggestUnitPrice } from "@/server/domain/catalog";
import type { Currency } from "@/server/domain/money";
import { RuleError, VersionConflictError } from "@/server/framework/errors";

/*
 * Price building blocks shared by the catalog actions. Not actions themselves: callers run them
 * inside their own defineAction transaction (scoped client) and do the permission check
 * (`price.change`) BEFORE calling.
 *
 * prices.ts holds the actions and the scheduling rule built on them. A price row is never edited in
 * place: a change closes the open period (validTo) and opens a new dated row. The database EXCLUDE
 * constraint (RtPrice_no_overlap) is the final arbiter against overlapping periods.
 */

type Tx = Prisma.TransactionClient;

/**
 * The largest price amount accepted, in minor units: 10^18, the same ceiling as parseMoneyText's
 * 15 integer digits allow with room to spare, and well below the BIGINT column maximum (~9.2e18).
 */
export const MAX_PRICE_MINOR = 10n ** 18n;

/** factor x base, refused (INVALID_INPUT) above MAX_PRICE_MINOR instead of overflowing the column. */
export function derivedUnitPrice(baseMinor: bigint, factor: number): bigint {
  const amount = suggestUnitPrice(baseMinor, factor);
  if (amount > MAX_PRICE_MINOR) throw new RuleError("INVALID_INPUT");
  return amount;
}

/** Money in minor units: a bigint or a string of digits (never a JS number), 0 to MAX_PRICE_MINOR. */
export const money = z
  .union([z.bigint(), z.string().regex(/^\d{1,19}$/).transform((v) => BigInt(v))])
  .refine((v) => v >= 0n && v <= MAX_PRICE_MINOR);

/** The currency must be one the business has enabled (INVALID_INPUT otherwise). */
export async function assertCurrencyEnabled(tx: Tx, currency: Currency): Promise<void> {
  const biz = await tx.rtBusiness.findFirst({ select: { enabledCurrencies: true } });
  if (!biz || !biz.enabledCurrencies.includes(currency)) throw new RuleError("INVALID_INPUT");
}

export type PriceListIds = { DEFAULT: string; WHOLESALE: string };

const LIST_NAMES = { DEFAULT: "الأسعار الافتراضية", WHOLESALE: "أسعار الجملة" } as const;

/**
 * The business's DEFAULT and WHOLESALE lists, created when missing. Idempotent and safe under
 * concurrency: INSERT ... ON CONFLICT DO NOTHING on the unique (businessId, kind).
 */
export async function ensureDefaultLists(tx: Tx, businessId: string): Promise<PriceListIds> {
  // The common case (the lists exist): one cheap read, no INSERT.
  const existing = await tx.rtPriceList.findMany({ select: { id: true, kind: true } });
  const have: Partial<PriceListIds> = {};
  for (const r of existing) have[r.kind] = r.id;
  if (have.DEFAULT && have.WHOLESALE) return have as PriceListIds;
  await tx.rtPriceList.createMany({
    data: [
      { businessId, kind: "DEFAULT", name: LIST_NAMES.DEFAULT },
      { businessId, kind: "WHOLESALE", name: LIST_NAMES.WHOLESALE },
    ],
    skipDuplicates: true,
  });
  const rows = await tx.rtPriceList.findMany({ select: { id: true, kind: true } });
  const ids: Partial<PriceListIds> = {};
  for (const r of rows) ids[r.kind] = r.id;
  if (!ids.DEFAULT || !ids.WHOLESALE) throw new Error("ensureDefaultLists: lists missing after insert");
  return ids as PriceListIds;
}

export type PriceInput = {
  /** The actor's business (the scoped client checks it; Prisma's create type needs it). */
  businessId: string;
  unitId: string;
  priceListId: string;
  currency: Currency;
  amountMinor: bigint;
  /** null: now (the real clock, read after the latest row is found). */
  validFrom: Date | null;
  /**
   * Stale-edit guard. undefined: none. Otherwise the id of the NEWEST row of the key (it may be a
   * scheduled one) that the caller saw (null: it saw no price); anything else gives VERSION_CONFLICT.
   */
  expectedLatestId?: string | null;
};

export type AppliedPrice = {
  id: string;
  validFrom: Date;
  replacedPriceId: string | null;
  previousAmountMinor: bigint | null;
};

/** How far ahead a validFrom may be (the past is bounded by PAST_GRACE_MS). */
export const MAX_VALID_FROM_AHEAD_MS = 10 * 366 * 86_400_000;

/** How far in the past an explicit validFrom may be and still count as "now" (UI latency, clock skew). */
export const PAST_GRACE_MS = 60_000;
/** A latest row that starts at most this far ahead of now is treated as "just now" (see applyPrice). */
export const NUDGE_MS = 5;

function mentions(value: unknown, ...needles: string[]): boolean {
  const seen = new Set<unknown>();
  const walk = (x: unknown, depth: number): boolean => {
    if (depth > 6 || x === null || x === undefined) return false;
    if (typeof x === "string") return needles.some((n) => x.includes(n));
    if (typeof x !== "object" || seen.has(x)) return false;
    seen.add(x);
    if (x instanceof Error && walk(x.message, depth + 1)) return true;
    return Object.values(x as Record<string, unknown>).some((c) => walk(c, depth + 1));
  };
  return walk(value, 0);
}

/**
 * Turns the price table's own constraint refusals into the action's error codes (rethrows anything
 * else): the EXCLUDE constraint (23P01, overlapping periods: someone else changed this price) is a
 * VERSION_CONFLICT; the CHECKs (23514: validTo after validFrom, amount >= 0) are INVALID_INPUT.
 */
export function mapPriceConstraintError(err: unknown): never {
  if (mentions(err, "23P01", "RtPrice_no_overlap")) throw new VersionConflictError();
  if (mentions(err, "23514", "RtPrice_valid_to_after_from", "RtPrice_amount_nonneg")) throw new RuleError("INVALID_INPUT");
  throw err;
}

/**
 * Makes `amountMinor` the price of (unit, list, currency) from `validFrom` on: closes the latest
 * period of the key (the open one) at validFrom and opens a new row [validFrom, infinity).
 * Rules (the caller holds the product lock, so the read below cannot go stale):
 * - History is never rewritten: an explicit validFrom older than now - PAST_GRACE_MS is refused
 *   (INVALID_INPUT, details.reason IN_PAST), for a first price too. One within the grace window
 *   is clamped to now. A future validFrom schedules the price. The clock is the server's only.
 * - expectedLatestId set and different from the latest row's id: VERSION_CONFLICT.
 * - validFrom must be strictly after the latest row's validFrom (INVALID_INPUT, details.reason
 *   BEFORE_LATEST), so a scheduled row is never replaced; a later price chains behind it. When the
 *   price starts "now" and the latest row started at most NUDGE_MS ahead of now (or at the same
 *   millisecond) the new row starts 1 ms after it instead, so rapid consecutive writes all work.
 * - A database constraint refusal is mapped by mapPriceConstraintError.
 * Returns what was replaced, for the audit trail.
 */
export async function applyPrice(tx: Tx, p: PriceInput): Promise<AppliedPrice> {
  if (p.amountMinor < 0n || p.amountMinor > MAX_PRICE_MINOR) throw new RuleError("INVALID_INPUT");
  const key = { unitId: p.unitId, priceListId: p.priceListId, currency: p.currency };
  const now = new Date();
  let validFrom = p.validFrom ?? now;
  if (validFrom.getTime() < now.getTime() - PAST_GRACE_MS) throw new RuleError("INVALID_INPUT", { reason: "IN_PAST" });
  const immediate = validFrom.getTime() <= now.getTime();
  if (immediate) validFrom = now;
  const open = await tx.rtPrice.findFirst({
    where: { ...key, validTo: null },
    select: { id: true, validFrom: true, amountMinor: true },
  });
  if (p.expectedLatestId !== undefined && (open?.id ?? null) !== p.expectedLatestId) throw new VersionConflictError();
  try {
    if (open) {
      const ahead = open.validFrom.getTime() - validFrom.getTime();
      if (immediate && ahead >= 0 && ahead <= NUDGE_MS) validFrom = new Date(open.validFrom.getTime() + 1);
      if (open.validFrom.getTime() >= validFrom.getTime()) throw new RuleError("INVALID_INPUT", { reason: "BEFORE_LATEST" });
      const { count } = await tx.rtPrice.updateMany({
        where: { id: open.id, validTo: null },
        data: { validTo: validFrom, version: { increment: 1 } },
      });
      if (count === 0) throw new VersionConflictError();
    }
    const row = await tx.rtPrice.create({
      data: { businessId: p.businessId, ...key, amountMinor: p.amountMinor, validFrom, validTo: null },
      select: { id: true },
    });
    return { id: row.id, validFrom, replacedPriceId: open?.id ?? null, previousAmountMinor: open?.amountMinor ?? null };
  } catch (err) {
    if (err instanceof RuleError || err instanceof VersionConflictError) throw err;
    return mapPriceConstraintError(err);
  }
}

export type ResolvedPrice = {
  id: string;
  amountMinor: bigint;
  currency: Currency;
  listKind: RtPriceListKind;
  priceListId: string;
  validFrom: Date;
  validTo: Date | null;
};

const resolvedSelect = {
  id: true,
  amountMinor: true,
  currency: true,
  priceListId: true,
  validFrom: true,
  validTo: true,
  priceList: { select: { kind: true } },
} as const;

/**
 * The price of a unit in a currency at an instant. wholesale=true tries the WHOLESALE list and
 * falls back to DEFAULT when the unit has no wholesale price in that currency at that instant;
 * wholesale=false uses DEFAULT only. null: no price. `at` is the sale instant the caller decides.
 */
export async function resolvePrice(
  tx: Tx,
  q: { unitId: string; currency: Currency; at: Date; wholesale: boolean },
): Promise<ResolvedPrice | null> {
  const kinds: RtPriceListKind[] = q.wholesale ? ["WHOLESALE", "DEFAULT"] : ["DEFAULT"];
  for (const kind of kinds) {
    const row = await tx.rtPrice.findFirst({
      where: {
        unitId: q.unitId,
        currency: q.currency,
        priceList: { kind },
        validFrom: { lte: q.at },
        OR: [{ validTo: null }, { validTo: { gt: q.at } }],
      },
      select: resolvedSelect,
    });
    if (row) {
      const { priceList, ...rest } = row;
      return { ...rest, listKind: priceList.kind };
    }
  }
  return null;
}
