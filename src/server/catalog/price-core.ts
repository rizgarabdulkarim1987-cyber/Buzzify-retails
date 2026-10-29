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
   * Stale-edit guard. undefined: none. Otherwise the id of the latest row of the key that the
   * caller saw (null: it saw no price); anything else gives VERSION_CONFLICT.
   */
  expectedLatestId?: string | null;
};

export type AppliedPrice = {
  id: string;
  validFrom: Date;
  replacedPriceId: string | null;
  previousAmountMinor: bigint | null;
};

/** Where a validFrom may lie: not before 2000 and not more than ten years ahead. */
export const MIN_VALID_FROM = new Date("2000-01-01T00:00:00Z");
export const MAX_VALID_FROM_AHEAD_MS = 10 * 366 * 86_400_000;

/**
 * Makes `amountMinor` the price of (unit, list, currency) from `validFrom` on: closes the latest
 * period of the key (the open one) at validFrom and opens a new row [validFrom, infinity).
 * Rules (the caller holds the product lock, so the read below cannot go stale):
 * - expectedLatestId set and different from the latest row: VERSION_CONFLICT.
 * - validFrom must be strictly after the latest row's validFrom (INVALID_INPUT otherwise,
 *   details.reason "BEFORE_LATEST"): history is never rewritten and a scheduled row is never
 *   replaced; a later price chains behind it. validFrom null (now) that lands on the very
 *   millisecond the latest row started moves one millisecond on, so two quick edits both work.
 * - No row exists yet: any validFrom is fine (a first price may be back-dated or scheduled).
 * Returns what was replaced, for the audit trail.
 */
export async function applyPrice(tx: Tx, p: PriceInput): Promise<AppliedPrice> {
  if (p.amountMinor < 0n || p.amountMinor > MAX_PRICE_MINOR) throw new RuleError("INVALID_INPUT");
  const key = { unitId: p.unitId, priceListId: p.priceListId, currency: p.currency };
  const open = await tx.rtPrice.findFirst({
    where: { ...key, validTo: null },
    select: { id: true, validFrom: true, amountMinor: true },
  });
  if (p.expectedLatestId !== undefined && (open?.id ?? null) !== p.expectedLatestId) throw new VersionConflictError();
  let validFrom = p.validFrom ?? new Date();
  if (open) {
    if (p.validFrom === null && open.validFrom.getTime() === validFrom.getTime()) validFrom = new Date(validFrom.getTime() + 1);
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
