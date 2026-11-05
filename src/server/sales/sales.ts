import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import type { Currency, RtPaymentMethod } from "@/generated/prisma/enums";
import { money, resolvePrice } from "@/server/catalog/price-core";
import { can } from "@/server/domain/permissions";
import { usdToDinar } from "@/server/domain/fx";
import { pickFefo, settlePayments, type Allocation, type StockRow } from "@/server/domain/sale";
import { businessToday, lineValueMinor, unitCostMinor } from "@/server/domain/stock";
import type { Actor } from "@/server/framework/actor";
import { defineAction } from "@/server/framework/action";
import { ForbiddenError, NotFoundError, RuleError } from "@/server/framework/errors";
import { updateVersioned } from "@/server/framework/versioned";
import { postMovements, type LedgerLine } from "@/server/stock/ledger";
import { businessOf, checkLine, loadCatalog, lockVariants, nextDocumentNumber, type LockBusiness } from "@/server/stock/posting";
import { openShiftOf, shiftLock } from "./shifts";

/*
 * Selling (R3, first slice: a market's cash desk). createSale posts a whole sale in ONE
 * transaction: the sale, its lines and payments, and its stock side (a SALE stock document whose
 * movements go through the ledger), or nothing at all.
 *
 * Rules (spec 4, 9, 10, 12 R3):
 * - Permission sale.create (OWNER, MANAGER, CASHIER). The sale is rung up on the seller's own OPEN
 *   shift (SHIFT_NOT_OPEN otherwise), in that shift's branch and location; the shift is re-read
 *   under its lock, so a sale and the shift's close never interleave.
 * - No double sale: the framework's idempotency key replays a retry; saleKey (the client's key for
 *   the sale, unique per business) is the backstop: a second post with a known saleKey returns the
 *   sale already posted (replayed: true) and writes nothing.
 * - Lines: an active, non-trial, non-serial item and a unit of it (checkLine of the stock posting);
 *   the quantity is typed in the unit (Arabic digits accepted, decimals up to the unit's scale).
 * - Price: the unit's current DEFAULT-list price in the business currency (resolvePrice, dated
 *   RtPrice), PRICE_MISSING without one. It is frozen on the line (list price, price row id, unit
 *   price, line total = unit price x quantity, half up). A different unit price is an override:
 *   discount.override only (OWNER, MANAGER), FORBIDDEN otherwise. expectedTotalMinor, when given,
 *   must equal the computed total (PRICE_CHANGED with the new total otherwise): the till never
 *   charges a total the cashier did not see.
 * - Payments: settlePayments (cash, card, mixed; change from cash only). Part or all of the cash may be
 *   dollars (one entry at most): the shift's rate (usdRateMicro, typed at opening) turns the dollars
 *   into dinars, the client's dinar value must equal the server's (RATE_MISMATCH otherwise), and a
 *   shift without a rate refuses dollars (USD_NOT_AVAILABLE). Settling happens in dinars only. Change
 *   is always in dinars, taken off the dinar cash row when there is one, else off the dollar row's kept
 *   amount; dinars that would all be change are CASH_NOT_NEEDED. A dollar row keeps the dollars handed
 *   over, the rate used, the dinar value kept (amountMinor) and the dinar value handed over (tenderedMinor).
 * - Stock: never negative; FEFO across batches for a BATCH item, expired batches never sold
 *   (STOCK_EXPIRED when only expired stock would cover it); the no-batch row for any other item.
 *   The stock is read under the variants' locks, so two tills on the last piece serialize and the
 *   second is refused with STOCK_NEGATIVE. The ledger values the outflow at the weighted average;
 *   that cost is kept on the sale line (never returned).
 * - Numbers: the stock document gets the business's next document number, the sale the branch's
 *   next sale number (RtSaleCounter), both in this transaction, so a refused sale consumes none.
 *
 * Locks, in this order: idempotency (framework) -> `shift:<id>` -> `stock:<variantId>` ascending
 * -> `stock-doc-number` -> `sale-number:<branchId>`.
 */

type Tx = Prisma.TransactionClient;

export const MAX_SALE_LINES = 200;
const MAX_PAYMENTS = 6;
const saleNumberLock = (branchId: string) => `sale-number:${branchId}`;

const id = z.string().min(1).max(64);

const lineInput = z
  .object({
    variantId: id,
    unitId: id,
    /** As typed in the unit. */
    quantity: z.string().min(1).max(40),
    /** An override of the list price (discount.override only). */
    unitPriceMinor: money.optional(),
  })
  .strict();

/** Cash in dinars (currency optional), cash in dollars (usdMinor cents; amountMinor is the dinar value the client computed), or card. */
const paymentInput = z.union([
  z.object({ method: z.literal("CASH"), currency: z.literal("IQD").optional(), amountMinor: money }).strict(),
  z.object({ method: z.literal("CASH"), currency: z.literal("USD"), usdMinor: money, amountMinor: money }).strict(),
  z.object({ method: z.literal("CARD"), amountMinor: money }).strict(),
]);

const createInput = z
  .object({
    saleKey: z.string().min(1).max(200),
    lines: z.array(lineInput).min(1).max(MAX_SALE_LINES),
    payments: z.array(paymentInput).max(MAX_PAYMENTS),
    expectedTotalMinor: money.optional(),
  })
  .strict();

export type SaleLineView = {
  lineNo: number;
  variantId: string;
  unitId: string;
  nameAr: string;
  nameCkb: string | null;
  nameEn: string | null;
  unitName: string;
  enteredQuantity: string;
  unitPriceMinor: bigint;
  lineTotalMinor: bigint;
};

export type SaleView = {
  saleId: string;
  number: number;
  saleKey: string;
  branchId: string;
  shiftId: string;
  cashierId: string;
  currency: Currency;
  totalMinor: bigint;
  paidMinor: bigint;
  changeMinor: bigint;
  postedAt: Date;
  lines: SaleLineView[];
  payments: SalePaymentView[];
};

export type SalePaymentView = {
  method: RtPaymentMethod;
  amountMinor: bigint;
  tenderedMinor: bigint;
  /** "USD" for a dollar payment, else null. */
  tenderedCurrency: Currency | null;
  /** USD cents handed over, or null. */
  tenderedForeignMinor: bigint | null;
  /** IQD per 1 USD x 10^6 used, or null. */
  rateMicro: bigint | null;
};

export type CreatedSale = SaleView & { replayed: boolean };

/** A posted sale as the receipt shows it (no cost). Two queries: the scoped client refuses branch-scoped relations for a branch-limited actor. */
export async function readSale(tx: Tx, where: { id: string } | { saleKey: string }): Promise<SaleView | null> {
  const sale = await tx.rtSale.findFirst({
    where,
    select: {
      id: true,
      number: true,
      saleKey: true,
      branchId: true,
      shiftId: true,
      cashierId: true,
      currency: true,
      totalMinor: true,
      paidMinor: true,
      changeMinor: true,
      postedAt: true,
    },
  });
  if (!sale) return null;
  const [lines, payments] = await Promise.all([
    tx.rtSaleLine.findMany({
      where: { saleId: sale.id },
      orderBy: { lineNo: "asc" },
      select: {
        lineNo: true,
        variantId: true,
        unitId: true,
        nameAr: true,
        nameCkb: true,
        nameEn: true,
        unitName: true,
        enteredQuantity: true,
        unitPriceMinor: true,
        lineTotalMinor: true,
      },
    }),
    tx.rtPayment.findMany({
      where: { saleId: sale.id },
      orderBy: [{ method: "asc" }, { id: "asc" }],
      select: { method: true, amountMinor: true, tenderedMinor: true, tenderedCurrency: true, tenderedForeignMinor: true, rateMicro: true },
    }),
  ]);
  const { id: saleId, ...rest } = sale;
  return { saleId, ...rest, lines, payments };
}

type PricedLine = {
  lineNo: number;
  variantId: string;
  unitId: string;
  enteredQuantity: string;
  quantity: bigint;
  factor: number;
  tracksBatches: boolean;
  nameAr: string;
  nameCkb: string | null;
  nameEn: string | null;
  unitName: string;
  listPriceMinor: bigint;
  unitPriceMinor: bigint;
  priceId: string;
  lineTotalMinor: bigint;
};

/** The stock rows of these variants at the location, with their batches' dates (read under the variant locks). */
async function stockRows(tx: Tx, locationId: string, variantIds: string[]): Promise<Map<string, StockRow[]>> {
  const balances = await tx.rtStockBalance.findMany({
    where: { locationId, variantId: { in: variantIds }, qty: { gt: 0n } },
    select: { variantId: true, batchId: true, qty: true },
  });
  const batchIds = [...new Set(balances.map((b) => b.batchId).filter((b): b is string => b !== null))];
  const batches = batchIds.length
    ? await tx.rtBatch.findMany({ where: { id: { in: batchIds } }, select: { id: true, expiryDate: true, createdAt: true } })
    : [];
  const batchOf = new Map(batches.map((b) => [b.id, b]));
  const out = new Map<string, StockRow[]>();
  for (const b of balances) {
    const batch = b.batchId ? batchOf.get(b.batchId) : undefined;
    const list = out.get(b.variantId) ?? [];
    list.push({ batchId: b.batchId, qty: b.qty, expiryDate: batch?.expiryDate ?? null, createdAt: batch?.createdAt ?? null });
    out.set(b.variantId, list);
  }
  return out;
}

async function nextSaleNumber(tx: Tx, businessId: string, branchId: string, lockBusiness: LockBusiness): Promise<number> {
  await lockBusiness(saleNumberLock(branchId));
  await tx.rtSaleCounter.createMany({ data: [{ businessId, branchId }], skipDuplicates: true });
  const row = await tx.rtSaleCounter.update({
    where: { businessId_branchId: { businessId, branchId } },
    data: { nextNumber: { increment: 1 } },
    select: { nextNumber: true },
  });
  return row.nextNumber - 1;
}

type CreateInput = z.infer<typeof createInput>;

async function postSale(tx: Tx, actor: Actor, input: CreateInput, lockBusiness: LockBusiness): Promise<CreatedSale> {
  // The shift, under its lock (a close takes the same lock).
  const found = await openShiftOf(tx, actor);
  if (!found) throw new RuleError("SHIFT_NOT_OPEN");
  await lockBusiness(shiftLock(found.id));
  const shift = await tx.rtShift.findFirst({ where: { id: found.id, status: "OPEN" }, select: { id: true, branchId: true, locationId: true, currency: true, usdRateMicro: true } });
  if (!shift) throw new RuleError("SHIFT_NOT_OPEN");

  // A sale already posted under this key: return it, write nothing.
  const existing = await readSale(tx, { saleKey: input.saleKey });
  if (existing) return { ...existing, replayed: true };

  // Variant locks before reading the catalog and the stock (a catalog edit takes the same locks).
  await lockVariants(input.lines.map((l) => l.variantId), lockBusiness);
  const biz = await businessOf(tx);
  const lineData = input.lines.map((l, i) => ({
    lineNo: i + 1,
    variantId: l.variantId,
    unitId: l.unitId,
    enteredQuantity: l.quantity.trim(),
    batchCode: null,
    expiryDate: null,
    currency: null,
    unitCostMinor: null,
    rateMicro: null,
  }));
  const catalog = await loadCatalog(tx, lineData);
  const [products, units] = await Promise.all([
    tx.rtVariant.findMany({
      where: { id: { in: [...new Set(lineData.map((l) => l.variantId))] } },
      select: { id: true, product: { select: { nameAr: true, nameCkb: true, nameEn: true } } },
    }),
    tx.rtUnit.findMany({ where: { id: { in: [...new Set(lineData.map((l) => l.unitId))] } }, select: { id: true, name: true } }),
  ]);
  const namesOf = new Map(products.map((p) => [p.id, p.product]));
  const unitNameOf = new Map(units.map((u) => [u.id, u.name]));

  const now = new Date();
  const priced: PricedLine[] = [];
  for (const [i, l] of lineData.entries()) {
    const { variant, unit, quantity } = checkLine(l, catalog, biz);
    const price = await resolvePrice(tx, { unitId: l.unitId, currency: shift.currency, at: now, wholesale: false });
    if (!price) throw new RuleError("PRICE_MISSING", { lineNo: String(l.lineNo) });
    const override = input.lines[i]!.unitPriceMinor;
    const unitPriceMinor = override ?? price.amountMinor;
    if (unitPriceMinor !== price.amountMinor && !can(actor.role, "discount.override")) throw new ForbiddenError();
    let lineTotalMinor: bigint;
    try {
      lineTotalMinor = lineValueMinor(unitPriceMinor, l.enteredQuantity, unit);
    } catch (err) {
      if (err instanceof RuleError) throw new RuleError("INVALID_INPUT", { lineNo: String(l.lineNo) });
      throw err;
    }
    const names = namesOf.get(l.variantId)!;
    priced.push({
      lineNo: l.lineNo,
      variantId: l.variantId,
      unitId: l.unitId,
      enteredQuantity: l.enteredQuantity,
      quantity,
      factor: unit.factor,
      tracksBatches: variant.product.trackingMode === "BATCH",
      nameAr: names.nameAr,
      nameCkb: names.nameCkb,
      nameEn: names.nameEn,
      unitName: unitNameOf.get(l.unitId) ?? "",
      listPriceMinor: price.amountMinor,
      unitPriceMinor,
      priceId: price.id,
      lineTotalMinor,
    });
  }
  const totalMinor = priced.reduce((s, l) => s + l.lineTotalMinor, 0n);
  if (input.expectedTotalMinor !== undefined && input.expectedTotalMinor !== totalMinor) {
    throw new RuleError("PRICE_CHANGED", { totalMinor: totalMinor.toString() });
  }
  // Dollars: at most one entry, converted at the shift's rate; the client's dinar value must match.
  const usdEntries = input.payments.filter((p): p is Extract<typeof p, { currency: "USD" }> => p.method === "CASH" && p.currency === "USD");
  if (usdEntries.length > 1) throw new RuleError("INVALID_INPUT");
  const usdEntry = usdEntries[0];
  let usdDinar = 0n;
  if (usdEntry) {
    if (shift.usdRateMicro === null) throw new RuleError("PAYMENT_RULE", { reason: "USD_NOT_AVAILABLE" });
    usdDinar = usdToDinar(usdEntry.usdMinor, shift.usdRateMicro);
    if (usdDinar <= 0n) throw new RuleError("INVALID_INPUT");
    if (usdDinar !== usdEntry.amountMinor) throw new RuleError("PAYMENT_RULE", { reason: "RATE_MISMATCH" });
  }
  const settled = settlePayments(
    totalMinor,
    input.payments.map((p) => ({ method: p.method, amountMinor: p.amountMinor })),
  );

  // Stock: FEFO per line, in line order, from what the earlier lines left.
  const today = businessToday(now, biz.timezone);
  const rows = await stockRows(tx, shift.locationId, [...new Set(priced.map((l) => l.variantId))]);
  const picks: Allocation[][] = priced.map((l) => {
    const all = rows.get(l.variantId) ?? [];
    const candidates = l.tracksBatches ? all : all.filter((r) => r.batchId === null);
    const taken = pickFefo(candidates, l.quantity, today, l.lineNo);
    for (const t of taken) {
      const row = all.find((r) => r.batchId === t.batchId)!;
      row.qty -= t.qty;
    }
    return taken;
  });

  // The stock document and its lines (one per sale line; a line split over batches names none).
  const doc = await tx.rtStockDocument.create({
    data: { businessId: actor.businessId, branchId: shift.branchId, locationId: shift.locationId, kind: "SALE" },
    select: { id: true },
  });
  const stockLineIds: string[] = [];
  for (const [i, l] of priced.entries()) {
    const single = picks[i]!.length === 1 ? picks[i]![0]!.batchId : null;
    const line = await tx.rtStockLine.create({
      data: {
        businessId: actor.businessId,
        branchId: shift.branchId,
        documentId: doc.id,
        lineNo: l.lineNo,
        variantId: l.variantId,
        unitId: l.unitId,
        batchId: single,
        quantity: l.quantity,
        enteredQuantity: l.enteredQuantity,
      },
      select: { id: true },
    });
    stockLineIds.push(line.id);
  }
  const ledger: LedgerLine[] = priced.flatMap((l, i) =>
    picks[i]!.map((p) => ({ lineId: stockLineIds[i]!, variantId: l.variantId, batchId: p.batchId, qtyDelta: -p.qty })),
  );
  const posted = await postMovements(
    tx,
    { businessId: actor.businessId, documentId: doc.id, branchId: shift.branchId, locationId: shift.locationId, lines: ledger },
    lockBusiness,
  );
  const costOf = new Map<string, bigint>();
  for (const m of posted) costOf.set(m.lineId, (costOf.get(m.lineId) ?? 0n) - m.valueDeltaMinor);
  for (const [i, l] of priced.entries()) {
    const cost = costOf.get(stockLineIds[i]!) ?? 0n;
    await tx.rtStockLine.update({
      where: { id: stockLineIds[i]! },
      data: { valueMinor: cost, currency: biz.defaultCurrency, unitCostMinor: unitCostMinor(l.quantity, cost, l.factor) },
    });
  }
  const documentNumber = await nextDocumentNumber(tx, actor.businessId, lockBusiness);
  await updateVersioned(tx.rtStockDocument, { id: doc.id, status: "DRAFT" }, 1, {
    status: "POSTED",
    number: documentNumber,
    postedAt: now,
    postedById: actor.userId,
  });

  // The sale itself.
  const number = await nextSaleNumber(tx, actor.businessId, shift.branchId, lockBusiness);
  const sale = await tx.rtSale.create({
    data: {
      businessId: actor.businessId,
      branchId: shift.branchId,
      locationId: shift.locationId,
      shiftId: shift.id,
      stockDocumentId: doc.id,
      number,
      saleKey: input.saleKey,
      currency: shift.currency,
      totalMinor,
      paidMinor: settled.paidMinor,
      changeMinor: settled.changeMinor,
      lineCount: priced.length,
      cashierId: actor.userId,
      postedAt: now,
    },
    select: { id: true },
  });
  await tx.rtSaleLine.createMany({
    data: priced.map((l, i) => ({
      businessId: actor.businessId,
      branchId: shift.branchId,
      saleId: sale.id,
      lineNo: l.lineNo,
      variantId: l.variantId,
      unitId: l.unitId,
      nameAr: l.nameAr,
      nameCkb: l.nameCkb,
      nameEn: l.nameEn,
      unitName: l.unitName,
      enteredQuantity: l.enteredQuantity,
      quantity: l.quantity,
      listPriceMinor: l.listPriceMinor,
      unitPriceMinor: l.unitPriceMinor,
      priceId: l.priceId,
      lineTotalMinor: l.lineTotalMinor,
      costMinor: costOf.get(stockLineIds[i]!) ?? 0n,
    })),
  });
  // The change is paid from the dinar drawer: off the dinar cash row, else off the dollar row's kept amount.
  const iqdTendered = settled.cashTenderedMinor - usdDinar;
  if (iqdTendered > 0n && settled.changeMinor >= iqdTendered) throw new RuleError("PAYMENT_RULE", { reason: "CASH_NOT_NEEDED" });
  const payments: {
    method: RtPaymentMethod;
    amountMinor: bigint;
    tenderedMinor: bigint;
    tenderedCurrency?: Currency;
    tenderedForeignMinor?: bigint;
    rateMicro?: bigint;
  }[] = [];
  if (iqdTendered > 0n) payments.push({ method: "CASH", amountMinor: iqdTendered - settled.changeMinor, tenderedMinor: iqdTendered });
  if (usdEntry) {
    payments.push({
      method: "CASH",
      amountMinor: usdDinar - (iqdTendered > 0n ? 0n : settled.changeMinor),
      tenderedMinor: usdDinar,
      tenderedCurrency: "USD",
      tenderedForeignMinor: usdEntry.usdMinor,
      rateMicro: shift.usdRateMicro!,
    });
  }
  if (settled.cardMinor > 0n) payments.push({ method: "CARD", amountMinor: settled.cardMinor, tenderedMinor: settled.cardMinor });
  if (payments.length > 0) {
    await tx.rtPayment.createMany({
      data: payments.map((p) => ({
        businessId: actor.businessId,
        branchId: shift.branchId,
        saleId: sale.id,
        shiftId: shift.id,
        currency: shift.currency,
        ...p,
      })),
    });
  }

  const view = await readSale(tx, { id: sale.id });
  if (!view) throw new Error("postSale: the sale just written is missing");
  return { ...view, replayed: false };
}

/** Posts a sale on the seller's open shift: lines, payments and stock, all or nothing (see the header). */
export const createSale = defineAction({
  name: "sale.create",
  permission: "sale.create",
  input: createInput,
  writes: true,
  timeoutMs: 20_000,
  run: ({ actor, tx, input, lockBusiness }) => postSale(tx, actor, input, lockBusiness),
  audit: (_input, value) => ({
    entity: "RtSale",
    entityId: value.saleId,
    changes: {
      number: value.number,
      totalMinor: value.totalMinor,
      lines: value.lines.length,
      payments: value.payments.map((p) => p.method),
      replayed: value.replayed,
    },
  }),
});

/** A posted sale (the receipt), in the actor's branches. */
export const getSale = defineAction({
  name: "sale.get",
  permission: "sale.create",
  input: z.object({ saleId: id }).strict(),
  writes: false,
  async run({ tx, input }): Promise<SaleView> {
    const sale = await readSale(tx, { id: input.saleId });
    if (!sale) throw new NotFoundError();
    return sale;
  },
});
