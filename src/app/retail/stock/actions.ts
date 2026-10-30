"use server";

import { getProduct } from "@/server/catalog/products";
import { adjustStock, writeOffStock } from "@/server/stock/adjust";
import { getVariantStock, listMovements, listStock } from "@/server/stock/queries";
import { call, fail } from "../catalog/_lib/call";
import { batchDto, movementDto, stockRowDto } from "./_lib/format";
import type { AdjustDone, AdjustSetup, MovementPage, StockPage, StockResult } from "./_lib/types";

/*
 * The browser's door to the stock actions, on the catalog screens' pattern: the session and the
 * business come from the server (never from the browser), the input is narrowed to plain values,
 * the action does every check (membership, permission, the business gate, idempotency), and the
 * result comes back typed with quantities and money as digit strings. Value keys are copied only
 * when the action returned them (cost.view). An unexpected failure is INTERNAL with no detail.
 */

type Wire = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const optId = (v: unknown): string | null => (typeof v === "string" && v !== "" && v.length <= 64 ? v : null);
const optCursor = (v: unknown): string | null => (typeof v === "string" && v !== "" && v.length <= 2048 ? v : null);

/** One page of the stock list. With expiringOnly a page can be short, even empty, while nextCursor is set: keep paging. */
export async function listStockAction(input: Wire): Promise<StockResult<StockPage>> {
  const cursor = optCursor(input.cursor);
  return call(
    "",
    (m) => listStock({ query: str(input.query).slice(0, 100), expiringOnly: input.expiringOnly === true, ...(cursor ? { cursor } : {}) }, m),
    (page): StockPage => ({ rows: page.rows.map(stockRowDto), nextCursor: page.nextCursor }),
  );
}

/** One page of a variant's movements, newest first, with the balance after each. */
export async function listMovementsAction(input: Wire): Promise<StockResult<MovementPage>> {
  const variantId = optId(input.variantId);
  if (!variantId) return fail("NOT_FOUND");
  const cursor = optCursor(input.cursor);
  return call(
    "",
    (m) => listMovements({ variantId, ...(cursor ? { cursor } : {}) }, m),
    (page): MovementPage => ({ rows: page.rows.map(movementDto), nextCursor: page.nextCursor }),
  );
}

/**
 * What the adjust dialog needs, read when it opens (so it never works from an old list): the
 * product's tracking, the variant's active units and the batches holding stock.
 */
export async function adjustSetupAction(input: Wire): Promise<StockResult<AdjustSetup>> {
  const productId = optId(input.productId);
  const variantId = optId(input.variantId);
  if (!productId || !variantId) return fail("NOT_FOUND");
  const product = await call("", (m) => getProduct({ id: productId }, m));
  if (!product.ok) return product;
  const p = product.value;
  const variant = p.variants.find((v) => v.id === variantId);
  if (!variant) return fail("NOT_FOUND");
  const stock = await call("", (m) => getVariantStock({ variantId }, m));
  if (!stock.ok) return stock;
  return {
    ok: true,
    value: {
      productId: p.id,
      variantId: variant.id,
      nameAr: p.nameAr,
      nameCkb: p.nameCkb,
      nameEn: p.nameEn,
      sku: variant.sku,
      trackingMode: p.trackingMode,
      tracksExpiry: p.tracksExpiry,
      isTestData: p.isTestData,
      archived: p.archivedAt !== null || variant.archivedAt !== null,
      units: variant.units
        .filter((u) => u.archivedAt === null)
        .map((u) => ({ id: u.id, name: u.name, factor: u.factor, quantityScale: u.quantityScale, isBase: u.isBase })),
      batches: stock.value.batches.map(batchDto),
    },
  };
}

/**
 * Posts one adjustment (IN / OUT) or write-off. `key` is the idempotency key of this attempt: the
 * dialog keeps it while the same form is retried after a lost answer, so a retry never posts twice.
 */
export async function adjustAction(key: unknown, input: Wire): Promise<StockResult<AdjustDone>> {
  const variantId = optId(input.variantId);
  const unitId = optId(input.unitId);
  if (!variantId || !unitId) return fail("INVALID_INPUT");
  const batchId = optId(input.batchId);
  const note = str(input.note).slice(0, 1000);
  const fields = { variantId, unitId, batchId, quantity: str(input.quantity).slice(0, 40), note: note.trim() === "" ? null : note };
  const reason = str(input.reason);
  const done = (posted: { documentId: string; number: number; warnings: { code: string }[] }): AdjustDone => ({
    documentId: posted.documentId,
    number: posted.number,
    costUnknown: posted.warnings.some((w) => w.code === "COST_UNKNOWN"),
  });
  if (input.mode === "WRITE_OFF") {
    if (reason !== "DAMAGED" && reason !== "EXPIRED" && reason !== "OTHER") return fail("INVALID_INPUT");
    return call(key, (m) => writeOffStock({ ...fields, reason }, m), done);
  }
  if (input.mode !== "IN" && input.mode !== "OUT") return fail("INVALID_INPUT");
  if (reason !== "LOST" && reason !== "COUNT_FIX" && reason !== "OTHER") return fail("INVALID_INPUT");
  const direction = input.mode;
  return call(key, (m) => adjustStock({ ...fields, direction, reason }, m), done);
}
