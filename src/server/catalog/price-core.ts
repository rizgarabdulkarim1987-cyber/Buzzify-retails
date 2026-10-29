import type { Prisma } from "@/generated/prisma/client";
import type { Currency } from "@/server/domain/money";
import { RuleError, VersionConflictError } from "@/server/framework/errors";

/*
 * Price building blocks shared by the catalog actions. Not actions themselves: callers run them
 * inside their own defineAction transaction (scoped client) and do the permission check
 * (`price.change`) BEFORE calling.
 *
 * Kept minimal on purpose (Task 5 needs them to store the optional price of createProduct/addUnit).
 * Task 6 owns the full price rules: the setPrice action, getPriceAt/resolvePrice, scheduling a
 * future price and locking the current row. A price row is never edited in place: a change closes
 * the open period (validTo) and opens a new dated row. The database EXCLUDE constraint
 * (RtPrice_no_overlap) is the final arbiter against overlapping periods.
 */

type Tx = Prisma.TransactionClient;

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
  validFrom: Date;
};

/**
 * Makes `amountMinor` the price of (unit, list, currency) from `validFrom` on: closes the open
 * period at validFrom and opens a new row [validFrom, ∞). Refuses (INVALID_INPUT) a validFrom that
 * is not after the open period's start (rewriting history is Task 6's question, not allowed here).
 * A concurrent change of the same open row gives VERSION_CONFLICT. Returns the new row's id.
 */
export async function applyPrice(tx: Tx, p: PriceInput): Promise<string> {
  if (p.amountMinor < 0n) throw new RuleError("INVALID_INPUT");
  const key = { unitId: p.unitId, priceListId: p.priceListId, currency: p.currency };
  const open = await tx.rtPrice.findFirst({ where: { ...key, validTo: null }, select: { id: true, validFrom: true } });
  if (open) {
    if (open.validFrom.getTime() >= p.validFrom.getTime()) throw new RuleError("INVALID_INPUT");
    const { count } = await tx.rtPrice.updateMany({
      where: { id: open.id, validTo: null },
      data: { validTo: p.validFrom, version: { increment: 1 } },
    });
    if (count === 0) throw new VersionConflictError();
  }
  const row = await tx.rtPrice.create({
    data: { businessId: p.businessId, ...key, amountMinor: p.amountMinor, validFrom: p.validFrom, validTo: null },
    select: { id: true },
  });
  return row.id;
}
