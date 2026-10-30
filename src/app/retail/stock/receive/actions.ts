"use server";

import { searchCatalog } from "@/server/catalog/search";
import { discardStockDraft, getStockDocument, postStockDocument, saveStockDraft } from "@/server/stock/documents";
import { call, fail, metaFor } from "../../catalog/_lib/call";
import { loadReceiptItem } from "../_lib/receipt-load";
import type { ItemInfo } from "../_lib/receipt-rules";
import type { ReceiptDoneDto } from "../_lib/receipt-views";
import type { StockResult } from "../_lib/types";

/*
 * The browser's door to receiving (src/server/stock/documents.ts), on the stock screens' pattern:
 * session and business from the server, input narrowed to plain values, every check in the
 * actions. A draft is saved whole (the action replaces its lines), version-checked; a post is keyed
 * by the caller so a retry after a lost answer replays it instead of posting twice.
 */

type Wire = Record<string, unknown>;

const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.slice(0, max) : "");
const optId = (v: unknown): string | null => (typeof v === "string" && v !== "" && v.length <= 64 ? v : null);
const optVersion = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null);

export type ReceiveHit = {
  productId: string;
  variantId: string;
  unitId?: string;
  nameAr: string;
  nameCkb?: string;
  nameEn?: string;
  sku: string;
  matchedBarcode?: string;
  matchedUnitName?: string;
  archived: boolean;
  isTestData: boolean;
};

/** Items matching a scanned barcode or typed text (at most 8). No price leaves the server. */
export async function receiveSearchAction(query: unknown): Promise<StockResult<ReceiveHit[]>> {
  const q = str(query, 100).trim();
  if (q === "") return { ok: true, value: [] };
  return call(
    "",
    (m) => searchCatalog({ query: q, limit: 8 }, m),
    (page) =>
      page.items.map(
        (h): ReceiveHit => ({
          productId: h.productId,
          variantId: h.variantId,
          ...(h.unitId ? { unitId: h.unitId } : {}),
          nameAr: h.nameAr,
          ...(h.nameCkb ? { nameCkb: h.nameCkb } : {}),
          ...(h.nameEn ? { nameEn: h.nameEn } : {}),
          sku: h.sku,
          ...(h.matchedBarcode ? { matchedBarcode: h.matchedBarcode } : {}),
          ...(h.matchedUnitName ? { matchedUnitName: h.matchedUnitName } : {}),
          archived: h.archived,
          isTestData: h.isTestData,
        }),
      ),
  );
}

/** One item as a line needs it (units, tracking), read fresh when it is scanned or picked. */
export async function receiveItemAction(input: Wire): Promise<StockResult<ItemInfo>> {
  const productId = optId(input.productId);
  const variantId = optId(input.variantId);
  if (!productId || !variantId) return fail("NOT_FOUND");
  const meta = await metaFor("");
  if (!meta) return fail("FORBIDDEN");
  return loadReceiptItem(productId, variantId, meta);
}

function draftLines(raw: unknown): Wire[] | null {
  if (!Array.isArray(raw) || raw.length > 500) return null;
  const out: Wire[] = [];
  for (const l of raw as unknown[]) {
    if (typeof l !== "object" || l === null) return null;
    const w = l as Wire;
    const line: Wire = { variantId: str(w.variantId, 64), unitId: str(w.unitId, 64), quantity: str(w.quantity, 40) };
    if (typeof w.cost === "object" && w.cost !== null) {
      const c = w.cost as Wire;
      line.cost = { amount: str(c.amount, 40), currency: str(c.currency, 3) };
    }
    if (typeof w.rate === "string") line.rate = str(w.rate, 40);
    if (typeof w.batchCode === "string") line.batchCode = str(w.batchCode, 64);
    if (typeof w.expiryDate === "string") line.expiryDate = str(w.expiryDate, 10);
    out.push(line);
  }
  return out;
}

/**
 * Creates the draft (no documentId) or replaces it (documentId + expectedVersion). `key` is this
 * attempt's idempotency key: the same lines sent again after a lost answer reuse it.
 */
export async function saveReceiptDraftAction(key: unknown, input: Wire): Promise<StockResult<{ documentId: string; version: number }>> {
  const kind = input.kind === "OPENING" || input.kind === "RECEIPT" ? input.kind : null;
  const lines = draftLines(input.lines);
  if (!kind || !lines) return fail("INVALID_INPUT");
  const documentId = optId(input.documentId);
  const expectedVersion = optVersion(input.expectedVersion);
  if ((documentId === null) !== (expectedVersion === null)) return fail("INVALID_INPUT");
  const supplierRef = typeof input.supplierRef === "string" ? input.supplierRef.slice(0, 200) : null;
  const note = typeof input.note === "string" ? input.note.slice(0, 1000) : null;
  return call(key, (m) =>
    saveStockDraft({ kind, lines, supplierRef, note, ...(documentId && expectedVersion ? { documentId, expectedVersion } : {}) }, m),
  );
}

/** Deletes the draft (version-checked). */
export async function discardReceiptAction(key: unknown, input: Wire): Promise<StockResult<{ documentId: string }>> {
  const documentId = optId(input.documentId);
  const expectedVersion = optVersion(input.expectedVersion);
  if (!documentId || !expectedVersion) return fail("INVALID_INPUT");
  return call(key, (m) => discardStockDraft({ documentId, expectedVersion }, m));
}

/**
 * Posts the draft, then reads the posted document again for the summary: a replayed post (same
 * key after a lost answer) returns no costs, so the total comes from the document itself, and only
 * for a caller the read gives costs to (cost.view).
 */
export async function postReceiptAction(key: unknown, input: Wire): Promise<StockResult<ReceiptDoneDto>> {
  const documentId = optId(input.documentId);
  const expectedVersion = optVersion(input.expectedVersion);
  if (!documentId || !expectedVersion) return fail("INVALID_INPUT");
  const posted = await call(key, (m) => postStockDocument({ documentId, expectedVersion }, m));
  if (!posted.ok) return posted;
  return summaryOf(documentId, posted.value.warnings);
}

/** The summary of a posted document (also for a reload after posting: no warnings are kept then). */
export async function postedSummaryAction(documentId: unknown): Promise<StockResult<ReceiptDoneDto>> {
  const id = optId(documentId);
  if (!id) return fail("NOT_FOUND");
  return summaryOf(id, []);
}

async function summaryOf(documentId: string, warnings: ReceiptDoneDto["warnings"]): Promise<StockResult<ReceiptDoneDto>> {
  const doc = await call("", (m) => getStockDocument({ documentId }, m));
  if (!doc.ok) return doc;
  const d = doc.value;
  if (d.status !== "POSTED" || d.number === null || (d.kind !== "RECEIPT" && d.kind !== "OPENING")) return fail("NOT_FOUND");
  const seesCost = d.lines.some((l) => "valueMinor" in l);
  const total = d.lines.reduce((sum, l) => sum + (l.valueMinor ?? 0n), 0n);
  return {
    ok: true,
    value: {
      documentId: d.id,
      number: d.number,
      kind: d.kind,
      lineCount: d.lines.length,
      ...(seesCost ? { totalMinor: total.toString() } : {}),
      warnings: warnings.map((w) => ({ lineNo: w.lineNo, code: w.code })),
    },
  };
}
