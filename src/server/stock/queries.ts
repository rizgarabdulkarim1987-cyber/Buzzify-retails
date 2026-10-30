import { z } from "zod";
import type { Prisma, RtRole } from "@/generated/prisma/client";
import type { Currency, RtStockDocumentKind } from "@/generated/prisma/enums";
import { MAX_CURSOR_LENGTH, MAX_QUERY_LENGTH, MAX_SEARCH_LIMIT, searchInTx } from "@/server/catalog/search";
import { can } from "@/server/domain/permissions";
import { businessToday, expiryStatus, splitIntoUnits, unitCostMinor } from "@/server/domain/stock";
import { NotFoundError, RuleError } from "@/server/framework/errors";
import { defineAction } from "@/server/framework/action";
import { defaultPlace } from "./posting";

/*
 * Stock reads (spec 4, 6b; rulings R-P and R-D). Every read needs stock.view (all roles have it) and
 * runs with writes:false. Values and costs are returned only with cost.view: without it no key that
 * names a value or a cost exists in the response (the keys are left out, never set to null).
 *
 * - On hand (`qty`) counts every balance row. `availableQty` leaves out the rows of batches whose
 *   expiry is EXPIRED today (businessToday in the business time zone); an expired OPENING batch is
 *   on hand but not available. `status` and `nearestExpiry` look only at batches that still hold
 *   stock (qty > 0); the alert window is the product's expiryAlertDays, else 30.
 * - Value (R-P): a batch row can sit at qty 0 with an offsetting value, so a batch's value is never
 *   returned. Only the variant's total over its balance rows shows a value, and the average cost
 *   (per BASE unit, unitCostMinor with factor 1) is left out when the total quantity is 0.
 * - The scoped client already limits balances and movements to the actor's branches; R2 has one
 *   location per branch, and the totals add up the visible ones.
 * - Quantities are base units x 1000 (BigInt). `breakdown` splits an on-hand quantity into the
 *   variant's active units (largest first) plus a remainder in base x 1000.
 */

type Tx = Prisma.TransactionClient;

const DAY_MS = 86_400_000;
const DEFAULT_ALERT_DAYS = 30;
const DEFAULT_LIMIT = 25;
const MAX_FILL_PAGES = 8;

const id = z.string().min(1).max(64);
const cursorField = z.string().min(1).max(MAX_CURSOR_LENGTH);

export type ExpiryState = "NONE" | "OK" | "SOON" | "EXPIRED";
export type Breakdown = { parts: { name: string; count: bigint }[]; remainder: bigint };

// ---------------------------------------------------------------------------------------------
// Shared loading

const showsCost = (role: RtRole) => can(role, "cost.view");

async function todayOf(tx: Tx): Promise<Date> {
  const biz = await tx.rtBusiness.findFirstOrThrow({ select: { timezone: true } });
  return businessToday(new Date(), biz.timezone);
}

type BalanceRow = { variantId: string; batchId: string | null; qty: bigint; valueMinor: bigint };
type BatchInfo = { id: string; code: string | null; expiryDate: Date | null };
type VariantInfo = { alertDays: number; units: { name: string; factor: number }[]; baseFactor: number };

type Facts = { balances: Map<string, BalanceRow[]>; batches: Map<string, BatchInfo>; variants: Map<string, VariantInfo> };

/** Balances, their batches and the units of these variants: a constant number of queries. */
async function loadFacts(tx: Tx, variantIds: string[]): Promise<Facts> {
  const balances = new Map<string, BalanceRow[]>();
  const batches = new Map<string, BatchInfo>();
  const variants = new Map<string, VariantInfo>();
  if (variantIds.length === 0) return { balances, batches, variants };

  const rows = await tx.rtStockBalance.findMany({
    where: { variantId: { in: variantIds } },
    select: { variantId: true, batchId: true, qty: true, valueMinor: true },
  });
  for (const r of rows) {
    const list = balances.get(r.variantId);
    if (list) list.push(r);
    else balances.set(r.variantId, [r]);
  }
  const batchIds = [...new Set(rows.map((r) => r.batchId).filter((b): b is string => b !== null))];
  if (batchIds.length > 0) {
    for (const b of await tx.rtBatch.findMany({ where: { id: { in: batchIds } }, select: { id: true, code: true, expiryDate: true } })) {
      batches.set(b.id, b);
    }
  }
  const found = await tx.rtVariant.findMany({
    where: { id: { in: variantIds } },
    select: {
      id: true,
      product: { select: { expiryAlertDays: true } },
      units: { where: { archivedAt: null }, select: { name: true, factor: true, isBase: true } },
    },
  });
  for (const v of found) {
    variants.set(v.id, {
      alertDays: v.product.expiryAlertDays ?? DEFAULT_ALERT_DAYS,
      units: v.units.map((u) => ({ name: u.name, factor: u.factor })),
      baseFactor: v.units.find((u) => u.isBase)?.factor ?? 1,
    });
  }
  return { balances, batches, variants };
}

type Summary = { qty: bigint; availableQty: bigint; valueMinor: bigint; nearestExpiry: Date | null; status: ExpiryState };

function summarize(rows: BalanceRow[], batches: Map<string, BatchInfo>, alertDays: number, today: Date): Summary {
  let qty = 0n;
  let availableQty = 0n;
  let valueMinor = 0n;
  let nearest: Date | null = null;
  for (const r of rows) {
    qty += r.qty;
    valueMinor += r.valueMinor;
    const expiry = r.batchId === null ? null : (batches.get(r.batchId)?.expiryDate ?? null);
    if (expiryStatus(expiry, today, 0) !== "EXPIRED") availableQty += r.qty;
    if (r.qty > 0n && expiry !== null && (nearest === null || expiry < nearest)) nearest = expiry;
  }
  return { qty, availableQty, valueMinor, nearestExpiry: nearest, status: expiryStatus(nearest, today, alertDays) };
}

/**
 * The value keys, present only for a cost.view holder, and only while the variant holds stock: at
 * qty 0 a leftover (rounding or reversal) value is not shown as if something were on hand.
 */
function valueKeys(s: Summary, baseFactor: number): { valueMinor?: bigint; avgUnitCostMinor?: bigint } {
  return s.qty > 0n ? { valueMinor: s.valueMinor, avgUnitCostMinor: unitCostMinor(s.qty, s.valueMinor, baseFactor) } : {};
}

// ---------------------------------------------------------------------------------------------
// listStock

const listStockInput = z
  .object({
    query: z.string().max(MAX_QUERY_LENGTH).default(""),
    categoryId: id.optional(),
    expiringOnly: z.boolean().default(false),
    cursor: cursorField.optional(),
    limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

export type StockRow = {
  productId: string;
  variantId: string;
  nameAr: string;
  /** The Kurdish and English names, when the product has them (as the catalog search gives them). */
  nameCkb?: string;
  nameEn?: string;
  sku: string;
  qty: bigint;
  availableQty: bigint;
  breakdown: Breakdown;
  nearestExpiry: Date | null;
  status: ExpiryState;
  /** The product or variant is archived; listed only while it still holds stock. */
  archived?: true;
  valueMinor?: bigint;
  avgUnitCostMinor?: bigint;
};

/**
 * The stock list. The variants, their order and the paging are searchCatalog's (a barcode or SKU
 * first, then by name; keyset cursor); this joins the balances for the page. With expiringOnly it
 * keeps only the variants holding SOON or EXPIRED stock and reads search pages until `limit` rows are
 * collected; nextCursor sits right after the last hit used. A page is shorter than `limit` only when
 * the search is exhausted (nextCursor null) or MAX_FILL_PAGES search pages were read (nextCursor
 * not null: keep paging). Archived items are listed (with `archived`) only while they hold stock
 * (qty > 0), so stock is never hidden by archiving; an archived item without stock is skipped like
 * a non-expiring one under expiringOnly.
 */
export const listStock = defineAction({
  name: "stock.list",
  permission: "stock.view",
  input: listStockInput,
  writes: false,
  timeoutMs: 20_000,
  async run({ actor, tx, input }): Promise<{ rows: StockRow[]; nextCursor: string | null }> {
    const today = await todayOf(tx);
    const withCost = showsCost(actor.role);
    const rows: StockRow[] = [];
    // Search pages are read until `limit` rows are collected, the search ends or MAX_FILL_PAGES is
    // hit: usually one page, more when hits are skipped (archived without stock; with expiringOnly,
    // search pages of 50 hits and everything not expiring).
    const pageSize = input.expiringOnly ? MAX_SEARCH_LIMIT : input.limit;
    let cursor = input.cursor;
    let nextCursor: string | null = null;

    for (let page = 0; page < MAX_FILL_PAGES; page++) {
      const found = await searchInTx(tx, { query: input.query, categoryId: input.categoryId, includeArchived: true, cursor, limit: pageSize });
      const facts = await loadFacts(tx, found.items.map((i) => i.variantId));
      let consumed = found.items.length; // hits of this page that are behind us once the page is full
      for (let i = 0; i < found.items.length; i++) {
        const hit = found.items[i]!;
        const info = facts.variants.get(hit.variantId);
        if (!info) continue;
        const s = summarize(facts.balances.get(hit.variantId) ?? [], facts.batches, info.alertDays, today);
        if (hit.archived && s.qty <= 0n) continue;
        if (input.expiringOnly && !(s.qty > 0n && (s.status === "EXPIRED" || s.status === "SOON"))) continue;
        rows.push({
          productId: hit.productId,
          variantId: hit.variantId,
          nameAr: hit.nameAr,
          ...(hit.nameCkb ? { nameCkb: hit.nameCkb } : {}),
          ...(hit.nameEn ? { nameEn: hit.nameEn } : {}),
          sku: hit.sku,
          qty: s.qty,
          availableQty: s.availableQty,
          breakdown: splitIntoUnits(s.qty, info.units),
          nearestExpiry: s.nearestExpiry,
          status: s.status,
          ...(hit.archived ? { archived: true as const } : {}),
          ...(withCost ? valueKeys(s, info.baseFactor) : {}),
        });
        if (rows.length === input.limit) {
          consumed = i + 1;
          break;
        }
      }
      if (consumed < found.items.length) {
        // The page filled in the middle of a search page: the cursor goes right after the last
        // hit used, which the search itself gives for a page of exactly that many hits.
        const upTo = await searchInTx(tx, { query: input.query, categoryId: input.categoryId, includeArchived: true, cursor, limit: consumed });
        nextCursor = upTo.nextCursor;
        break;
      }
      nextCursor = found.nextCursor;
      cursor = found.nextCursor ?? undefined;
      if (rows.length >= input.limit || nextCursor === null) break;
    }
    return { rows, nextCursor };
  },
});

// ---------------------------------------------------------------------------------------------
// getVariantStock

export type VariantBatch = { batchId: string | null; code: string | null; expiry: Date | null; status: ExpiryState; qty: bigint };
export type VariantStock = {
  /** The variant's product and names, so a screen can title the variant from its id alone. */
  productId: string;
  nameAr: string;
  nameCkb: string | null;
  nameEn: string | null;
  sku: string;
  batches: VariantBatch[];
  total: {
    qty: bigint;
    availableQty: bigint;
    breakdown: Breakdown;
    nearestExpiry: Date | null;
    status: ExpiryState;
    valueMinor?: bigint;
    avgUnitCostMinor?: bigint;
  };
};

/**
 * One variant's batches that still hold stock, earliest expiry first (no expiry last; the no-batch
 * row has batchId null), and its total. A batch carries no value (R-P); the total does, with cost.view.
 * With includeEmpty, every batch of the variant is listed, also those at qty 0 (an IN adjustment can
 * go back into a used-up batch); the no-batch row is still listed only when it holds stock.
 */
export const getVariantStock = defineAction({
  name: "stock.variant",
  permission: "stock.view",
  input: z.object({ variantId: id, includeEmpty: z.boolean().default(false) }).strict(),
  writes: false,
  async run({ actor, tx, input }): Promise<VariantStock> {
    const exists = await tx.rtVariant.findFirst({
      where: { id: input.variantId },
      select: { id: true, sku: true, productId: true, product: { select: { nameAr: true, nameCkb: true, nameEn: true } } },
    });
    if (!exists) throw new NotFoundError();
    const today = await todayOf(tx);
    const facts = await loadFacts(tx, [input.variantId]);
    const info = facts.variants.get(input.variantId);
    if (!info) throw new NotFoundError();
    const rows = facts.balances.get(input.variantId) ?? [];

    const perBatch = new Map<string | null, bigint>();
    for (const r of rows) perBatch.set(r.batchId, (perBatch.get(r.batchId) ?? 0n) + r.qty);
    if (input.includeEmpty) {
      const all = await tx.rtBatch.findMany({ where: { variantId: input.variantId }, select: { id: true, code: true, expiryDate: true } });
      for (const b of all) {
        facts.batches.set(b.id, b);
        if (!perBatch.has(b.id)) perBatch.set(b.id, 0n);
      }
    }
    const batches: VariantBatch[] = [];
    for (const [batchId, qty] of perBatch) {
      if (qty < 0n || (qty === 0n && !(input.includeEmpty && batchId !== null))) continue;
      const b = batchId === null ? null : (facts.batches.get(batchId) ?? null);
      batches.push({
        batchId,
        code: b?.code ?? null,
        expiry: b?.expiryDate ?? null,
        status: expiryStatus(b?.expiryDate ?? null, today, info.alertDays),
        qty,
      });
    }
    batches.sort((x, y) => {
      if (x.expiry && y.expiry) return x.expiry.getTime() - y.expiry.getTime() || (x.code ?? "").localeCompare(y.code ?? "");
      if (x.expiry) return -1;
      if (y.expiry) return 1;
      return (x.code ?? "").localeCompare(y.code ?? "");
    });

    const s = summarize(rows, facts.batches, info.alertDays, today);
    return {
      productId: exists.productId,
      nameAr: exists.product.nameAr,
      nameCkb: exists.product.nameCkb,
      nameEn: exists.product.nameEn,
      sku: exists.sku,
      batches,
      total: {
        qty: s.qty,
        availableQty: s.availableQty,
        breakdown: splitIntoUnits(s.qty, info.units),
        nearestExpiry: s.nearestExpiry,
        status: s.status,
        ...(showsCost(actor.role) ? valueKeys(s, info.baseFactor) : {}),
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// listMovements

const movementCursor = z.object({ t: z.string().datetime(), i: id }).strict();

function decodeMovementCursor(raw: string): { t: Date; i: string } {
  try {
    const c = movementCursor.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return { t: new Date(c.t), i: c.i };
  } catch {
    throw new RuleError("INVALID_INPUT");
  }
}

const encodeMovementCursor = (t: Date, i: string): string => Buffer.from(JSON.stringify({ t: t.toISOString(), i }), "utf8").toString("base64url");

export type MovementRow = {
  id: string;
  createdAt: Date;
  documentId: string;
  documentKind: RtStockDocumentKind;
  documentNumber: number | null;
  locationId: string;
  batchId: string | null;
  batchCode: string | null;
  qtyDelta: bigint;
  /** The variant's quantity at this movement's location right after it. */
  qtyAfter: bigint;
  valueDeltaMinor?: bigint;
  /** The variant's value at the location right after the movement (never per batch). */
  valueAfterMinor?: bigint;
};

/**
 * A variant's movements, newest first (createdAt, then id, descending), with the running balance
 * after each: the variant's total at the movement's location, summed over its batches. Keyset
 * paged (opaque cursor). The first row's balance is the location's current balance minus everything
 * newer; the rest follow by subtracting each row's delta.
 * Caveat: createdAt is the start time of the posting transaction, so two documents posted by
 * concurrent transactions are ordered by when they began, not when they committed; the balances stay
 * exact for the order shown (ties on createdAt are broken by id).
 */
export const listMovements = defineAction({
  name: "stock.movements",
  permission: "stock.view",
  input: z.object({ variantId: id, cursor: cursorField.optional(), limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_LIMIT) }).strict(),
  writes: false,
  async run({ actor, tx, input }): Promise<{ rows: MovementRow[]; nextCursor: string | null }> {
    const exists = await tx.rtVariant.findFirst({ where: { id: input.variantId }, select: { id: true } });
    if (!exists) throw new NotFoundError();
    const withCost = showsCost(actor.role);
    const after = input.cursor !== undefined ? decodeMovementCursor(input.cursor) : null;
    const where: Prisma.RtStockMovementWhereInput = {
      variantId: input.variantId,
      ...(after ? { OR: [{ createdAt: { lt: after.t } }, { createdAt: after.t, id: { lt: after.i } }] } : {}),
    };
    const found = await tx.rtStockMovement.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      select: { id: true, createdAt: true, documentId: true, locationId: true, batchId: true, qtyDelta: true, valueDeltaMinor: true },
    });
    const page = found.slice(0, input.limit);
    const last = page[page.length - 1];
    const nextCursor = found.length > input.limit && last ? encodeMovementCursor(last.createdAt, last.id) : null;
    if (page.length === 0) return { rows: [], nextCursor };

    // The balance after the first row of the page: the location's balance now (the sum of its
    // balance rows, at most locations x batches rows) minus everything newer than that row. Page 1
    // has nothing newer; a deep page pays one scan of the newer movements (O(depth), by index).
    const first = page[0]!;
    const run = new Map<string, { qty: bigint; value: bigint }>();
    const now = await tx.rtStockBalance.groupBy({ by: ["locationId"], where: { variantId: input.variantId }, _sum: { qty: true, valueMinor: true } });
    for (const t of now) run.set(t.locationId, { qty: t._sum.qty ?? 0n, value: t._sum.valueMinor ?? 0n });
    if (after !== null) {
      const newer = await tx.rtStockMovement.groupBy({
        by: ["locationId"],
        where: { variantId: input.variantId, OR: [{ createdAt: { gt: first.createdAt } }, { createdAt: first.createdAt, id: { gt: first.id } }] },
        _sum: { qtyDelta: true, valueDeltaMinor: true },
      });
      for (const n of newer) {
        const r = run.get(n.locationId);
        if (r) {
          r.qty -= n._sum.qtyDelta ?? 0n;
          r.value -= n._sum.valueDeltaMinor ?? 0n;
        }
      }
    }

    const docs = await tx.rtStockDocument.findMany({
      where: { id: { in: [...new Set(page.map((m) => m.documentId))] } },
      select: { id: true, kind: true, number: true },
    });
    const docOf = new Map(docs.map((d) => [d.id, d]));
    const batchIds = [...new Set(page.map((m) => m.batchId).filter((b): b is string => b !== null))];
    const batches = batchIds.length > 0 ? await tx.rtBatch.findMany({ where: { id: { in: batchIds } }, select: { id: true, code: true } }) : [];
    const codeOf = new Map(batches.map((b) => [b.id, b.code]));

    const rows: MovementRow[] = [];
    for (const m of page) {
      const doc = docOf.get(m.documentId);
      if (!doc) throw new Error(`listMovements: movement ${m.id} has no document in scope`);
      const r = run.get(m.locationId) ?? { qty: 0n, value: 0n };
      rows.push({
        id: m.id,
        createdAt: m.createdAt,
        documentId: m.documentId,
        documentKind: doc.kind,
        documentNumber: doc.number,
        locationId: m.locationId,
        batchId: m.batchId,
        batchCode: m.batchId === null ? null : (codeOf.get(m.batchId) ?? null),
        qtyDelta: m.qtyDelta,
        qtyAfter: r.qty,
        ...(withCost ? { valueDeltaMinor: m.valueDeltaMinor, valueAfterMinor: r.value } : {}),
      });
      r.qty -= m.qtyDelta;
      r.value -= m.valueDeltaMinor;
      run.set(m.locationId, r);
    }
    return { rows, nextCursor };
  },
});

// ---------------------------------------------------------------------------------------------
// listExpiring

export type ExpiringRow = {
  productId: string;
  variantId: string;
  nameAr: string;
  nameCkb: string | null;
  nameEn: string | null;
  sku: string;
  batchId: string;
  code: string | null;
  expiry: Date;
  /** Negative once expired. */
  daysLeft: number;
  status: ExpiryState;
  qty: bigint;
  breakdown: Breakdown;
};

/**
 * Batches that hold stock and are EXPIRED or expire within `withinDays` (default: each product's
 * expiryAlertDays, else 30), earliest first, by the business time zone. Every such batch is
 * returned (no paging: they are the ones the owner must act on). No value or cost.
 */
export const listExpiring = defineAction({
  name: "stock.expiring",
  permission: "stock.view",
  input: z.object({ withinDays: z.number().int().min(0).max(3650).optional() }).strict(),
  writes: false,
  async run({ tx, input }): Promise<{ rows: ExpiringRow[] }> {
    const today = await todayOf(tx);
    // The widest window any product could ask for bounds the query; the exact test is below.
    const widest =
      input.withinDays ??
      Math.max(DEFAULT_ALERT_DAYS, (await tx.rtProduct.aggregate({ _max: { expiryAlertDays: true } }))._max.expiryAlertDays ?? 0);
    const cutoff = new Date(today.getTime() + widest * DAY_MS);

    const balances = await tx.rtStockBalance.findMany({
      where: { qty: { gt: 0n }, batchId: { not: null }, batch: { expiryDate: { not: null, lte: cutoff } } },
      select: { variantId: true, batchId: true, qty: true },
    });
    const perBatch = new Map<string, { variantId: string; qty: bigint }>();
    for (const b of balances) {
      if (b.batchId === null) continue;
      const cur = perBatch.get(b.batchId);
      if (cur) cur.qty += b.qty;
      else perBatch.set(b.batchId, { variantId: b.variantId, qty: b.qty });
    }
    if (perBatch.size === 0) return { rows: [] };

    const batches = await tx.rtBatch.findMany({ where: { id: { in: [...perBatch.keys()] } }, select: { id: true, code: true, expiryDate: true } });
    const variantIds = [...new Set([...perBatch.values()].map((b) => b.variantId))];
    const variants = await tx.rtVariant.findMany({
      where: { id: { in: variantIds } },
      select: {
        id: true,
        sku: true,
        productId: true,
        product: { select: { nameAr: true, nameCkb: true, nameEn: true, expiryAlertDays: true } },
        units: { where: { archivedAt: null }, select: { name: true, factor: true } },
      },
    });
    const variantOf = new Map(variants.map((v) => [v.id, v]));

    const rows: ExpiringRow[] = [];
    for (const b of batches) {
      const held = perBatch.get(b.id);
      const v = held ? variantOf.get(held.variantId) : undefined;
      if (!held || !v || b.expiryDate === null) continue;
      const window = input.withinDays ?? v.product.expiryAlertDays ?? DEFAULT_ALERT_DAYS;
      const daysLeft = Math.round((b.expiryDate.getTime() - today.getTime()) / DAY_MS);
      // The status is the product's own (its alert days); `withinDays` only widens or narrows the filter.
      const status = expiryStatus(b.expiryDate, today, v.product.expiryAlertDays ?? DEFAULT_ALERT_DAYS);
      if (daysLeft > window && expiryStatus(b.expiryDate, today, 0) !== "EXPIRED") continue;
      rows.push({
        productId: v.productId,
        variantId: v.id,
        nameAr: v.product.nameAr,
        nameCkb: v.product.nameCkb,
        nameEn: v.product.nameEn,
        sku: v.sku,
        batchId: b.id,
        code: b.code,
        expiry: b.expiryDate,
        daysLeft,
        status,
        qty: held.qty,
        breakdown: splitIntoUnits(held.qty, v.units),
      });
    }
    rows.sort((x, y) => x.expiry.getTime() - y.expiry.getTime() || x.nameAr.localeCompare(y.nameAr) || x.batchId.localeCompare(y.batchId));
    return { rows };
  },
});

// ---------------------------------------------------------------------------------------------
// stockContext

export type StockContext = {
  role: RtRole;
  /** The default location (where receipts and adjustments are posted); null when the business has none yet. */
  locationId: string | null;
  canReceive: boolean;
  canAdjust: boolean;
  canSeeCost: boolean;
  defaultCurrency: Currency;
  enabledCurrencies: Currency[];
  /** IQD per 1 USD x 10^6 on the latest posted line in a foreign currency; null if none. Left out for a caller who cannot receive. */
  lastRateMicro?: bigint | null;
};

const RATE_PAGE = 50;
const RATE_PAGES = 20;

/** The rate on the most recent posted line in a currency other than the default (documents newest first). */
async function lastForeignRate(tx: Tx, defaultCurrency: Currency): Promise<bigint | null> {
  let skip = 0;
  for (let page = 0; page < RATE_PAGES; page++) {
    const docs = await tx.rtStockDocument.findMany({
      where: { status: "POSTED" },
      orderBy: [{ postedAt: "desc" }, { id: "desc" }],
      skip,
      take: RATE_PAGE,
      select: { id: true },
    });
    if (docs.length === 0) return null;
    const lines = await tx.rtStockLine.findMany({
      where: { documentId: { in: docs.map((d) => d.id) }, currency: { not: defaultCurrency }, rateMicro: { not: null } },
      select: { documentId: true, lineNo: true, rateMicro: true },
    });
    if (lines.length > 0) {
      const rank = new Map(docs.map((d, i) => [d.id, i]));
      lines.sort((a, b) => rank.get(a.documentId)! - rank.get(b.documentId)! || b.lineNo - a.lineNo);
      return lines[0]!.rateMicro;
    }
    skip += RATE_PAGE;
  }
  return null;
}

/** What the stock screens need before they draw. Only fields the screens use. */
export const stockContext = defineAction({
  name: "stock.context",
  permission: "stock.view",
  input: z.object({}).strict(),
  writes: false,
  async run({ actor, tx }): Promise<StockContext> {
    const biz = await tx.rtBusiness.findFirstOrThrow({ select: { defaultCurrency: true, enabledCurrencies: true } });
    let locationId: string | null = null;
    try {
      locationId = (await defaultPlace(tx)).locationId;
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
    }
    const canReceive = can(actor.role, "stock.receive");
    return {
      role: actor.role,
      locationId,
      canReceive,
      canAdjust: can(actor.role, "stock.adjust"),
      canSeeCost: showsCost(actor.role),
      defaultCurrency: biz.defaultCurrency,
      enabledCurrencies: biz.enabledCurrencies,
      ...(canReceive ? { lastRateMicro: await lastForeignRate(tx, biz.defaultCurrency) } : {}),
    };
  },
});
