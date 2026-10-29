import { z } from "zod";
import { Currency, RtPriceListKind } from "@/generated/prisma/enums";
import { defineAction } from "@/server/framework/action";
import { NotFoundError, RuleError } from "@/server/framework/errors";
import {
  MAX_VALID_FROM_AHEAD_MS,
  MIN_VALID_FROM,
  applyPrice,
  assertCurrencyEnabled,
  derivedUnitPrice,
  ensureDefaultLists,
  money,
  resolvePrice,
} from "./price-core";
import { activeUnit, lockProductOfUnit } from "./products";

/*
 * Dated prices: a price belongs to (unit, price list, currency) and is valid over [validFrom,
 * validTo). A row is never edited or deleted; a change closes the latest period and opens a new one
 * (applyPrice in price-core). So the price of any past instant stays answerable by getPriceAt.
 *
 * Rules (spec sections 5 and 6):
 * - setPrice needs price.change (OWNER, MANAGER). It takes lockBusiness(productLock(product of the
 *   unit)) first, the same lock as every other catalog change, so two edits of one unit queue up
 *   and each reads the other's committed rows. That lock is the "lock on the current row": it also
 *   covers a missing row (a first price), which a row lock could not.
 * - validFrom omitted = now, from the server clock only (no clock parameter). The accepted range is
 *   2000-01-01 to ten years ahead (INVALID_INPUT outside it).
 * - SCHEDULING RULE. Per (unit, list, currency) the rows form one chain. The latest row is the
 *   open one (validTo null); it is either current or, if its validFrom is in the future, scheduled.
 *   A new price must start strictly AFTER the latest row's validFrom, else INVALID_INPUT with
 *   details.reason BEFORE_LATEST. Consequences: a future validFrom closes the current row at that
 *   instant, so the current price stays current until then; a "change now" while a price is
 *   scheduled is refused (the scheduled row is never deleted or edited: history and plans are
 *   append-only), and a price starting after the scheduled one chains behind it. Cancelling a
 *   scheduled price is therefore not possible in R1; a later change supersedes it only once it
 *   has started. A first price (no row yet) may be back-dated or scheduled freely.
 * - Amount 0 is allowed (a free item, a giveaway; the database allows >= 0). Negative or above
 *   MAX_PRICE_MINOR: INVALID_INPUT. The currency must be enabled for the business.
 * - Stale-edit guard: the optional expectedCurrentPriceId is the id of the latest price row of this
 *   (unit, list, currency) that the editor was looking at (null: "there was no price"). If another
 *   change happened since, VERSION_CONFLICT and nothing is written. Omitted: no guard, the last
 *   save simply becomes a new dated row (nothing is ever overwritten).
 * - The list is named by priceListId or, for a business that has no lists yet, by listKind; the
 *   lists are created on demand under the lock (ensureDefaultLists). Reads never create anything.
 * - The unit must be active, its variant and product too. Ids of other businesses are NOT_FOUND.
 */

const id = z.string().min(1).max(64);
const currency = z.enum(Currency);

const setPriceInput = z
  .object({
    unitId: id,
    priceListId: id.optional(),
    listKind: z.enum(RtPriceListKind).optional(),
    currency,
    amountMinor: money,
    validFrom: z.date().optional(),
    expectedCurrentPriceId: id.nullable().optional(),
  })
  .strict()
  .refine((v) => (v.priceListId === undefined) !== (v.listKind === undefined));

export type SetPriceResult = {
  id: string;
  amountMinor: bigint;
  validFrom: Date;
  replacedPriceId: string | null;
  previousAmountMinor: bigint | null;
};

/** Makes amountMinor the price of the unit in the list and currency from validFrom (default now). */
export const setPrice = defineAction({
  name: "catalog.price.set",
  permission: "price.change",
  input: setPriceInput,
  writes: true,
  async run({ actor, tx, input, lockBusiness }): Promise<SetPriceResult> {
    await lockProductOfUnit(tx, lockBusiness, input.unitId);
    const unit = await tx.rtUnit.findFirst({ where: { id: input.unitId, ...activeUnit }, select: { id: true } });
    if (!unit) throw new NotFoundError();
    if (input.validFrom) {
      const t = input.validFrom.getTime();
      if (t < MIN_VALID_FROM.getTime() || t > Date.now() + MAX_VALID_FROM_AHEAD_MS) throw new RuleError("INVALID_INPUT");
    }
    await assertCurrencyEnabled(tx, input.currency);
    const lists = await ensureDefaultLists(tx, actor.businessId);
    let priceListId: string;
    if (input.priceListId !== undefined) {
      if (input.priceListId !== lists.DEFAULT && input.priceListId !== lists.WHOLESALE) throw new NotFoundError();
      priceListId = input.priceListId;
    } else {
      priceListId = lists[input.listKind!];
    }
    const applied = await applyPrice(tx, {
      businessId: actor.businessId,
      unitId: unit.id,
      priceListId,
      currency: input.currency,
      amountMinor: input.amountMinor,
      validFrom: input.validFrom ?? null,
      expectedLatestId: input.expectedCurrentPriceId,
    });
    return { ...applied, amountMinor: input.amountMinor };
  },
  audit: (input, value) => ({
    entity: "RtPrice",
    entityId: value.id,
    changes: { input, replacedPriceId: value.replacedPriceId, previousAmountMinor: value.previousAmountMinor, validFrom: value.validFrom },
  }),
});

const priceSelect = { id: true, amountMinor: true, currency: true, validFrom: true, validTo: true, version: true } as const;

/** The price whose period contains `at` (the caller names the instant), or null. */
export const getPriceAt = defineAction({
  name: "catalog.price.at",
  permission: null,
  input: z.object({ unitId: id, priceListId: id, currency, at: z.date() }).strict(),
  writes: false,
  async run({ tx, input }) {
    const unit = await tx.rtUnit.findFirst({ where: { id: input.unitId }, select: { id: true } });
    const list = await tx.rtPriceList.findFirst({ where: { id: input.priceListId }, select: { id: true } });
    if (!unit || !list) throw new NotFoundError();
    return tx.rtPrice.findFirst({
      where: {
        unitId: unit.id,
        priceListId: list.id,
        currency: input.currency,
        validFrom: { lte: input.at },
        OR: [{ validTo: null }, { validTo: { gt: input.at } }],
      },
      select: priceSelect,
    });
  },
});

export type PriceStatus = "CURRENT" | "SCHEDULED" | "CLOSED";

/** Every price row of a unit, newest start first, with its list kind and whether it is current, scheduled or closed. */
export const listUnitPrices = defineAction({
  name: "catalog.price.list",
  permission: null,
  input: z.object({ unitId: id }).strict(),
  writes: false,
  async run({ tx, input }) {
    const unit = await tx.rtUnit.findFirst({ where: { id: input.unitId }, select: { id: true } });
    if (!unit) throw new NotFoundError();
    const rows = await tx.rtPrice.findMany({
      where: { unitId: unit.id },
      orderBy: [{ validFrom: "desc" }, { id: "desc" }],
      select: { ...priceSelect, priceListId: true, priceList: { select: { kind: true } } },
    });
    const now = Date.now();
    return rows.map(({ priceList, ...r }) => {
      const status: PriceStatus = r.validFrom.getTime() > now ? "SCHEDULED" : r.validTo === null || r.validTo.getTime() > now ? "CURRENT" : "CLOSED";
      return { ...r, listKind: priceList.kind, status };
    });
  },
});

/** The business's price lists (empty until the first setPrice creates them; a read creates nothing). */
export const listPriceLists = defineAction({
  name: "catalog.priceList.list",
  permission: null,
  input: z.object({}).strict(),
  writes: false,
  async run({ tx }) {
    return tx.rtPriceList.findMany({ orderBy: { kind: "asc" }, select: { id: true, kind: true, name: true, version: true } });
  },
});

/**
 * "The suggested price now" shown next to a larger unit's stored price: factor x the base unit's
 * current DEFAULT price in that currency, or null when the base unit has none. A hint only: it is
 * never written anywhere (spec 7.9).
 */
export const suggestedUnitPrice = defineAction({
  name: "catalog.price.suggest",
  permission: null,
  input: z.object({ unitId: id, currency }).strict(),
  writes: false,
  async run({ tx, input }) {
    const unit = await tx.rtUnit.findFirst({ where: { id: input.unitId }, select: { variantId: true, factor: true } });
    if (!unit) throw new NotFoundError();
    const base = await tx.rtUnit.findFirst({ where: { variantId: unit.variantId, isBase: true }, select: { id: true } });
    if (!base) return null;
    const current = await resolvePrice(tx, { unitId: base.id, currency: input.currency, at: new Date(), wholesale: false });
    if (!current) return null;
    return { amountMinor: derivedUnitPrice(current.amountMinor, unit.factor), baseAmountMinor: current.amountMinor, factor: unit.factor };
  },
});
