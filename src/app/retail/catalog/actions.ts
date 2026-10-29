"use server";

import { addBarcode, addUnit, archiveBarcode, archiveProduct, archiveUnit, archiveVariant, createProduct, updateProduct, updateUnit } from "@/server/catalog/products";
import { setPrice } from "@/server/catalog/prices";
import { catalogContext } from "@/server/catalog/context";
import { searchCatalog, type CatalogHit } from "@/server/catalog/search";
import { createCategory } from "@/server/catalog/taxonomy";
import { normalizeBarcode, parseMoneyText } from "@/server/domain/catalog";
import { can } from "@/server/domain/permissions";
import { IdempotencyMismatchError, InternalActionError, type Result } from "@/server/framework/errors";
import type { ActionMeta } from "@/server/framework/action";
import { getLocale } from "../../_lib/i18n";
import { messagesFor } from "@/messages";
import { loadShell } from "../_shell";
import type { CategoryDto, Currency, HitDto, SearchPage, UiResult } from "./_lib/types";

/*
 * The browser's door to the catalog actions. Each function here is a thin wrapper: it takes the
 * session and the business from the server (never from the browser), turns what the screens type
 * (price text, a date, a barcode) into the values the actions want, calls the action, and returns
 * a typed result with money as digit strings. All checks (membership, permission, the business
 * gate, version, idempotency) are the actions' own; a wrapper never decides access. An
 * unexpected failure comes back as INTERNAL with no detail.
 */

type Wire = Record<string, unknown>;

const fail = (code: Extract<UiResult<never>, { ok: false }>["code"]): UiResult<never> => ({ ok: false, code });

async function metaFor(key: unknown): Promise<ActionMeta | null> {
  const shell = await loadShell();
  if (!shell?.businessId) return null;
  return { userId: shell.user.id, businessId: shell.businessId, idempotencyKey: typeof key === "string" ? key : "" };
}

async function call<T, V = T>(key: unknown, run: (meta: ActionMeta) => Promise<Result<T>>, map?: (v: T) => V): Promise<UiResult<V>> {
  const meta = await metaFor(key);
  if (!meta) return fail("FORBIDDEN");
  try {
    const r = await run(meta);
    if (!r.ok) return r.details ? { ok: false, code: r.code, details: r.details } : { ok: false, code: r.code };
    return { ok: true, value: map ? map(r.value) : (r.value as unknown as V) };
  } catch (err) {
    if (err instanceof IdempotencyMismatchError) return fail("IDEMPOTENCY_MISMATCH");
    if (err instanceof InternalActionError) return fail("INTERNAL");
    throw err;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const optId = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Money text to minor units; null for empty text; throws RangeError-like (caught by the caller) when it is not a valid amount. */
function parseAmount(text: unknown, currency: unknown): bigint | null | "BAD" {
  const t = str(text).trim();
  if (t === "") return null;
  if (currency !== "IQD" && currency !== "USD") return "BAD";
  try {
    return parseMoneyText(t, currency);
  } catch {
    return "BAD";
  }
}

// ---------------------------------------------------------------------------------------------
// Reads

function hitDto(h: CatalogHit): HitDto {
  const { unitPrice, ...rest } = h;
  return unitPrice ? { ...rest, unitPrice: { currency: unitPrice.currency, amountMinor: unitPrice.amountMinor.toString() } } : rest;
}

/** One page of the catalog list. Archived items are shown only to people who can manage the catalog. */
export async function searchAction(input: Wire): Promise<UiResult<SearchPage>> {
  const shell = await loadShell();
  const role = shell?.options?.ok ? shell.options.value.role : null;
  const query = str(input.query).slice(0, 100);
  return call(
    "",
    (m) =>
      searchCatalog(
        {
          query,
          ...(optId(input.categoryId) ? { categoryId: optId(input.categoryId) } : {}),
          ...(optId(input.brandId) ? { brandId: optId(input.brandId) } : {}),
          includeArchived: input.includeArchived === true && role !== null && can(role, "catalog.manage"),
          ...(optId(input.cursor) ? { cursor: optId(input.cursor) } : {}),
        },
        m,
      ),
    (page) => ({ items: page.items.map(hitDto), nextCursor: page.nextCursor }),
  );
}

export type BarcodeLookup = { exists: false } | { exists: true; productId: string };

/** Does a scanned code already belong to a product? (An archived barcode stays reserved: creating is then refused with BARCODE_TAKEN.) */
export async function lookupBarcodeAction(code: unknown): Promise<UiResult<BarcodeLookup>> {
  let normalized: string;
  try {
    normalized = normalizeBarcode(str(code));
  } catch {
    return fail("BAD_BARCODE");
  }
  return call(
    "",
    (m) => searchCatalog({ query: normalized, includeArchived: true, limit: 1 }, m),
    (page): BarcodeLookup => {
      const hit = page.items[0];
      return hit && hit.matchedBarcode === normalized ? { exists: true, productId: hit.productId } : { exists: false };
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Quick entry

export type QuickCreated = { productId: string; sku: string; price?: { currency: Currency; amountMinor: string } };

/**
 * One product from the quick-entry form: barcode (optional), one name, category (optional), price
 * text (optional). The name goes in the Arabic column (the required one) and also in the column of
 * the interface language when that is Kurdish or English.
 */
export async function quickCreateAction(key: unknown, input: Wire): Promise<UiResult<QuickCreated>> {
  const locale = await getLocale();
  const t = messagesFor(locale);
  const name = str(input.name).trim();
  if (name === "") return fail("BAD_NAME");
  const barcodeText = str(input.barcode).trim();
  let barcode: string | null = null;
  if (barcodeText !== "") {
    try {
      barcode = normalizeBarcode(barcodeText);
    } catch {
      return fail("BAD_BARCODE");
    }
  }
  const meta = await metaFor(key);
  if (!meta) return fail("FORBIDDEN");
  const context = await catalogContext({}, { ...meta, idempotencyKey: "" });
  if (!context.ok) return { ok: false, code: context.code };
  const currency: Currency = context.value.defaultCurrency;
  const amount = parseAmount(input.price, currency);
  if (amount === "BAD") return fail("BAD_PRICE");

  return call(
    key,
    (m) =>
      createProduct(
        {
          nameAr: name,
          ...(locale === "ckb" ? { nameCkb: name } : {}),
          ...(locale === "en" ? { nameEn: name } : {}),
          categoryId: optId(input.categoryId),
          baseUnit: { name: t.catalog.defaultUnit, barcodes: barcode ? [barcode] : [] },
          ...(amount !== null ? { price: { currency, amountMinor: amount } } : {}),
        },
        m,
      ),
    (v): QuickCreated => ({
      productId: v.productId,
      sku: v.sku,
      ...(amount !== null ? { price: { currency, amountMinor: amount.toString() } } : {}),
    }),
  );
}

/** Creates a root category from the quick-entry category box. The name goes where quickCreate puts product names. */
export async function createCategoryAction(key: unknown, input: Wire): Promise<UiResult<CategoryDto>> {
  const locale = await getLocale();
  const name = str(input.name).trim();
  if (name === "") return fail("BAD_NAME");
  return call(
    key,
    (m) =>
      createCategory(
        { nameAr: name, ...(locale === "ckb" ? { nameCkb: name } : {}), ...(locale === "en" ? { nameEn: name } : {}) },
        m,
      ),
    (c): CategoryDto => ({ id: c.id, parentId: c.parentId, nameAr: c.nameAr, nameCkb: c.nameCkb, nameEn: c.nameEn }),
  );
}

// ---------------------------------------------------------------------------------------------
// Product screen

const ack = () => ({ done: true as const });
export type Done = { done: true };

export async function updateProductAction(key: unknown, input: Wire): Promise<UiResult<{ version: number }>> {
  const tracksExpiry = input.tracksExpiry === true;
  const alert = str(input.expiryAlertDays).trim();
  const alertDays = tracksExpiry && alert !== "" ? Number(alert) : null;
  return call(
    key,
    (m) =>
      updateProduct(
        {
          id: str(input.id),
          expectedVersion: Number(input.expectedVersion),
          nameAr: str(input.nameAr),
          nameCkb: str(input.nameCkb),
          nameEn: str(input.nameEn),
          categoryId: optId(input.categoryId),
          brandId: optId(input.brandId),
          soldByWeight: input.soldByWeight === true,
          tracksExpiry,
          ...(tracksExpiry ? { trackingMode: "BATCH" } : {}),
          expiryAlertDays: alertDays,
        },
        m,
      ),
    (p) => ({ version: p.version }),
  );
}

export async function archiveProductAction(key: unknown, input: Wire): Promise<UiResult<Done>> {
  return call(key, (m) => archiveProduct({ id: str(input.id), expectedVersion: Number(input.expectedVersion) }, m), ack);
}

export async function archiveVariantAction(key: unknown, input: Wire): Promise<UiResult<Done>> {
  return call(key, (m) => archiveVariant({ variantId: str(input.variantId), expectedVersion: Number(input.expectedVersion) }, m), ack);
}

export async function updateUnitAction(key: unknown, input: Wire): Promise<UiResult<Done>> {
  return call(
    key,
    (m) =>
      updateUnit(
        { id: str(input.id), expectedVersion: Number(input.expectedVersion), name: str(input.name), quantityScale: Number(input.quantityScale) },
        m,
      ),
    ack,
  );
}

export async function archiveUnitAction(key: unknown, input: Wire): Promise<UiResult<Done>> {
  return call(key, (m) => archiveUnit({ id: str(input.id), expectedVersion: Number(input.expectedVersion) }, m), ack);
}

export async function addUnitAction(key: unknown, input: Wire): Promise<UiResult<Done>> {
  const factorText = str(input.factor).trim();
  const factor = /^\d{1,6}$/.test(factorText) ? Number(factorText) : NaN;
  if (!Number.isInteger(factor) || factor < 2) return fail("BAD_FACTOR");
  let code: string | null = null;
  if (str(input.barcode).trim() !== "") {
    try {
      code = normalizeBarcode(str(input.barcode));
    } catch {
      return fail("BAD_BARCODE");
    }
  }
  const amount = parseAmount(input.price, input.currency);
  if (amount === "BAD") return fail("BAD_PRICE");
  return call(
    key,
    (m) =>
      addUnit(
        {
          variantId: str(input.variantId),
          name: str(input.name),
          factor,
          barcodes: code ? [code] : [],
          ...(amount !== null ? { price: { currency: input.currency, amountMinor: amount } } : {}),
        },
        m,
      ),
    ack,
  );
}

export async function addBarcodeAction(key: unknown, input: Wire): Promise<UiResult<Done>> {
  let code: string;
  try {
    code = normalizeBarcode(str(input.code));
  } catch {
    return fail("BAD_BARCODE");
  }
  return call(key, (m) => addBarcode({ unitId: str(input.unitId), code }, m), ack);
}

export async function archiveBarcodeAction(key: unknown, input: Wire): Promise<UiResult<Done>> {
  return call(key, (m) => archiveBarcode({ id: str(input.id), expectedVersion: Number(input.expectedVersion) }, m), ack);
}

/** A price on the DEFAULT list. `startsAt` is a Baghdad calendar date (YYYY-MM-DD); today or the past means now. */
export async function setPriceAction(key: unknown, input: Wire): Promise<UiResult<Done>> {
  const amount = parseAmount(input.amount, input.currency);
  if (amount === null || amount === "BAD") return fail("BAD_PRICE");
  let validFrom: Date | undefined;
  const day = str(input.startsAt).trim();
  if (day !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return fail("BAD_DATE");
    const at = new Date(`${day}T00:00:00+03:00`);
    if (Number.isNaN(at.getTime())) return fail("BAD_DATE");
    if (at.getTime() > Date.now()) validFrom = at;
  }
  return call(
    key,
    (m) =>
      setPrice(
        {
          unitId: str(input.unitId),
          listKind: "DEFAULT",
          currency: input.currency,
          amountMinor: amount,
          ...(validFrom ? { validFrom } : {}),
          expectedLatestPriceId: typeof input.latestId === "string" ? input.latestId : null,
        },
        m,
      ),
    ack,
  );
}
