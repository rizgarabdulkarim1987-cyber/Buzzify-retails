import { getProduct } from "@/server/catalog/products";
import type { ActionMeta } from "@/server/framework/action";
import { getStockDocument, type StockDocumentView } from "@/server/stock/documents";
import { getVariantStock } from "@/server/stock/queries";
import type { DocumentDto, ItemInfo } from "./receipt-rules";
import type { StockFailure, StockResult } from "./types";

/*
 * Server-side reads of the receiving screen: an item as the form needs it, and a saved draft with
 * its items (a reload reopens the same draft). Cost keys are copied only when the action returned
 * them (cost.view), as digit strings; nothing here adds a cost the action left out.
 */

type Product = Extract<Awaited<ReturnType<typeof getProduct>>, { ok: true }>["value"];

const refused = (r: { code: StockFailure["code"]; details?: StockFailure["details"] }): { ok: false } & StockFailure =>
  r.details ? { ok: false, code: r.code, details: r.details } : { ok: false, code: r.code };

/** One variant of a product as the form needs it (active units only, the base unit first), or null. */
export function itemInfoOf(p: Product, variantId: string): ItemInfo | null {
  const variant = p.variants.find((v) => v.id === variantId);
  if (!variant) return null;
  const units = variant.units
    .filter((u) => u.archivedAt === null)
    .map((u) => ({ id: u.id, name: u.name, factor: u.factor, quantityScale: u.quantityScale, isBase: u.isBase }))
    .sort((a, b) => Number(b.isBase) - Number(a.isBase));
  return {
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
    units,
  };
}

/** One item, read fresh when it is scanned or picked. */
export async function loadReceiptItem(productId: string, variantId: string, meta: ActionMeta): Promise<StockResult<ItemInfo>> {
  const product = await getProduct({ id: productId }, meta);
  if (!product.ok) return refused(product);
  const item = itemInfoOf(product.value, variantId);
  return item ? { ok: true, value: item } : { ok: false, code: "NOT_FOUND" };
}

/** A document for the browser: quantities and money as digit strings, cost keys only when present. */
export function documentDto(v: StockDocumentView): DocumentDto {
  return {
    id: v.id,
    kind: v.kind,
    status: v.status,
    number: v.number,
    supplierRef: v.supplierRef,
    note: v.note,
    version: v.version,
    createdAt: v.createdAt.toISOString(),
    lines: v.lines.map((l) => ({
      lineNo: l.lineNo,
      variantId: l.variantId,
      unitId: l.unitId,
      quantity: l.quantity.toString(),
      enteredQuantity: l.enteredQuantity,
      batchCode: l.batchCode,
      expiryDate: l.expiryDate,
      costMissing: l.costMissing,
      ...("unitCostMinor" in l
        ? {
            currency: l.currency ?? null,
            unitCostMinor: l.unitCostMinor == null ? null : l.unitCostMinor.toString(),
            rateMicro: l.rateMicro == null ? null : l.rateMicro.toString(),
            valueMinor: l.valueMinor == null ? null : l.valueMinor.toString(),
          }
        : {}),
    })),
  };
}

export type LoadedDraft = { doc: DocumentDto; items: Record<string, ItemInfo> };

/**
 * A saved receipt or opening document with every item its lines name, read one after another
 * (each product once). A document of another kind is NOT_FOUND here: this screen does not open it.
 */
export async function loadReceiptDraft(documentId: string, meta: ActionMeta): Promise<StockResult<LoadedDraft>> {
  const doc = await getStockDocument({ documentId }, meta);
  if (!doc.ok) return refused(doc);
  if (doc.value.kind !== "RECEIPT" && doc.value.kind !== "OPENING") return { ok: false, code: "NOT_FOUND" };
  const items: Record<string, ItemInfo> = {};
  const products = new Map<string, Product>();
  for (const variantId of new Set(doc.value.lines.map((l) => l.variantId))) {
    const stock = await getVariantStock({ variantId }, meta);
    if (!stock.ok) return refused(stock);
    let product = products.get(stock.value.productId);
    if (!product) {
      const read = await getProduct({ id: stock.value.productId }, meta);
      if (!read.ok) return refused(read);
      product = read.value;
      products.set(product.id, product);
    }
    const item = itemInfoOf(product, variantId);
    if (!item) return { ok: false, code: "NOT_FOUND" };
    items[variantId] = item;
  }
  return { ok: true, value: { doc: documentDto(doc.value), items } };
}
