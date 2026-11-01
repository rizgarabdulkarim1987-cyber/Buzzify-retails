"use server";

import { getProduct } from "@/server/catalog/products";
import { can } from "@/server/domain/permissions";
import { adjustStock, writeOffStock } from "@/server/stock/adjust";
import { getVariantStock, listMovements, listStock } from "@/server/stock/queries";
import { grantAiConsent } from "@/server/intake/consent";
import {
  acknowledgeIntakeTotal,
  createDraftFromIntake,
  createIntake,
  createIntakeItems,
  resolveIntakeLine,
  runIntakeRead,
  setIntakeCurrency,
} from "@/server/intake/receipts";
import { loadShell } from "../_shell";
import { call, fail, metaFor } from "../catalog/_lib/call";
import { batchDto, movementDto, stockRowDto } from "./_lib/format";
import type { ItemInfo } from "./_lib/receipt-rules";
import type { AdjustDone, AdjustSetup, MovementPage, StockPage, StockResult } from "./_lib/types";
import { MAX_PAGES, MAX_PAGE_BYTES } from "./receive/photo/_lib/image";
import { loadIntakeReview, loadItems, type IntakeReview } from "./receive/photo/_lib/load";
import type { IntakeStatus } from "./receive/photo/_lib/rules";

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
  const stock = await call("", (m) => getVariantStock({ variantId, includeEmpty: true }, m));
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
  // "Valued at zero" speaks about cost: it reaches only a caller with cost.view.
  const shell = await loadShell();
  const seesCost = shell?.options?.ok === true && can(shell.options.value.role, "cost.view");
  const done = (posted: { documentId: string; number: number; warnings: { code: string }[] }): AdjustDone => ({
    documentId: posted.documentId,
    number: posted.number,
    ...(seesCost && posted.warnings.some((w) => w.code === "COST_UNKNOWN") ? { costUnknown: true as const } : {}),
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

// ---------------------------------------------------------------------------------------------
// Receipt photo intake (src/server/intake). Every action needs the ai.intake switch, ai.use,
// stock.receive and cost.view (the actions check them); prices reach the browser only through
// intakeReviewAction, for a caller with cost.view. Writes return ids and versions only. `key` is
// the idempotency key of one attempt: kept while the same intent is sent again after a lost answer.

const MAX_PAGE_BASE64 = Math.ceil(MAX_PAGE_BYTES / 3) * 4 + 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const optVersion = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null);
const optLineNo = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1000 ? v : null);

async function seesCostNow(): Promise<boolean> {
  const shell = await loadShell();
  return shell?.options?.ok === true && can(shell.options.value.role, "cost.view");
}

/** The owner agrees to send the business's images to the AI provider (the current consent text). */
export async function grantAiConsentAction(key: unknown): Promise<StockResult<{ consented: true }>> {
  return call(key, (m) => grantAiConsent({}, m), () => ({ consented: true as const }));
}

/** Uploads one receipt's pages (base64, made smaller in the browser) and reserves one read. */
export async function createIntakeAction(key: unknown, input: Wire): Promise<StockResult<{ intakeId: string; duplicateOf?: string }>> {
  const raw = input.files;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_PAGES) return fail("INVALID_INPUT");
  const files: { contentType: string; bytes: Uint8Array }[] = [];
  for (const f of raw as unknown[]) {
    if (typeof f !== "object" || f === null) return fail("INVALID_INPUT");
    const w = f as Wire;
    const data = w.data;
    if (typeof data !== "string" || data.length === 0 || data.length > MAX_PAGE_BASE64 || !BASE64.test(data)) return fail("INVALID_INPUT");
    files.push({ contentType: str(w.contentType).slice(0, 64), bytes: new Uint8Array(Buffer.from(data, "base64")) });
  }
  return call(key, (m) => createIntake({ files }, m));
}

/** Reads an uploaded intake (10-60 s); the answer is its status, or the failure. */
export async function runIntakeReadAction(key: unknown, intakeId: unknown): Promise<StockResult<{ status: IntakeStatus }>> {
  const id = optId(intakeId);
  if (!id) return fail("NOT_FOUND");
  return call(key, (m) => runIntakeRead({ intakeId: id }, m), (v) => ({ status: v.status }));
}

/** The intake as its review screen shows it, with the items its lines name (prices only with cost.view). */
export async function intakeReviewAction(intakeId: unknown): Promise<StockResult<IntakeReview>> {
  const id = optId(intakeId);
  if (!id) return fail("NOT_FOUND");
  const meta = await metaFor("");
  if (!meta) return fail("FORBIDDEN");
  return loadIntakeReview(id, meta, await seesCostNow());
}

/** One item picked for a line (a candidate or a search hit), with its active units. */
export async function intakeItemAction(variantId: unknown): Promise<StockResult<ItemInfo>> {
  const id = optId(variantId);
  if (!id) return fail("NOT_FOUND");
  const meta = await metaFor("");
  if (!meta) return fail("FORBIDDEN");
  const item = (await loadItems([id], meta))[id];
  return item ? { ok: true, value: item } : fail("NOT_FOUND");
}

type LineAction = { kind: "PICK_ITEM"; variantId: string; unitId: string } | { kind: "PICK_UNIT"; unitId: string } | { kind: "USE_TOTAL_DIV_QTY" } | { kind: "DISCARD" };

function lineAction(v: unknown): LineAction | null {
  if (typeof v !== "object" || v === null) return null;
  const a = v as Wire;
  switch (a.kind) {
    case "PICK_ITEM": {
      const variantId = optId(a.variantId);
      const unitId = optId(a.unitId);
      return variantId && unitId ? { kind: "PICK_ITEM", variantId, unitId } : null;
    }
    case "PICK_UNIT": {
      const unitId = optId(a.unitId);
      return unitId ? { kind: "PICK_UNIT", unitId } : null;
    }
    case "USE_TOTAL_DIV_QTY":
    case "DISCARD":
      return { kind: a.kind };
    default:
      return null;
  }
}

type Versioned = StockResult<{ intakeId: string; version: number }>;

/** Settles one line: pick the item and unit, confirm the unit (and so the item), price from the total, or remove it for good. */
export async function resolveIntakeLineAction(key: unknown, input: Wire): Promise<Versioned> {
  const intakeId = optId(input.intakeId);
  const lineNo = optLineNo(input.lineNo);
  const expectedVersion = optVersion(input.expectedVersion);
  const action = lineAction(input.action);
  if (!intakeId || !lineNo || !expectedVersion || !action) return fail("INVALID_INPUT");
  return call(key, (m) => resolveIntakeLine({ intakeId, lineNo, action, expectedVersion }, m));
}

/** The receipt's currency (one the business has enabled). */
export async function setIntakeCurrencyAction(key: unknown, input: Wire): Promise<Versioned> {
  const intakeId = optId(input.intakeId);
  const expectedVersion = optVersion(input.expectedVersion);
  const currency = input.currency === "IQD" || input.currency === "USD" ? input.currency : null;
  if (!intakeId || !expectedVersion || !currency) return fail("INVALID_INPUT");
  return call(key, (m) => setIntakeCurrency({ intakeId, currency, expectedVersion }, m));
}

/** Accepts a receipt total that does not match the lines (until what the check reads changes). */
export async function acknowledgeIntakeTotalAction(key: unknown, input: Wire): Promise<Versioned> {
  const intakeId = optId(input.intakeId);
  const expectedVersion = optVersion(input.expectedVersion);
  if (!intakeId || !expectedVersion) return fail("INVALID_INPUT");
  return call(key, (m) => acknowledgeIntakeTotal({ intakeId, expectedVersion }, m));
}

/** Creates a minimal item for each of these lines, all or none (catalog.manage). */
export async function createIntakeItemsAction(key: unknown, input: Wire): Promise<StockResult<{ intakeId: string; version: number; created: number }>> {
  const intakeId = optId(input.intakeId);
  const expectedVersion = optVersion(input.expectedVersion);
  const raw = input.lineNos;
  if (!intakeId || !expectedVersion || !Array.isArray(raw) || raw.length < 1 || raw.length > 50) return fail("INVALID_INPUT");
  const lineNos = (raw as unknown[]).map(optLineNo);
  if (lineNos.some((n) => n === null)) return fail("INVALID_INPUT");
  return call(key, (m) => createIntakeItems({ intakeId, lineNos: lineNos as number[], expectedVersion }, m), (v) => ({
    intakeId: v.intakeId,
    version: v.version,
    created: v.created,
  }));
}

/** Makes the receiving draft from a settled receipt; the receiving screen opens it next. */
export async function createDraftFromIntakeAction(key: unknown, input: Wire): Promise<StockResult<{ documentId: string }>> {
  const intakeId = optId(input.intakeId);
  const expectedVersion = optVersion(input.expectedVersion);
  if (!intakeId || !expectedVersion) return fail("INVALID_INPUT");
  return call(key, (m) => createDraftFromIntake({ intakeId, expectedVersion }, m));
}
