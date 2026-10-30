"use server";

import { addBarcode, addUnit, archiveBarcode, archiveProduct, archiveUnit, archiveVariant, addVariant, createProduct, getProduct, unarchiveProduct, updateProduct, updateUnit } from "@/server/catalog/products";
import { lookupBarcode, readBarcodeFromImage, type BarcodeRead } from "@/server/intake/barcode";
import { setPrice } from "@/server/catalog/prices";
import { catalogContext } from "@/server/catalog/context";
import { searchCatalog, type CatalogHit } from "@/server/catalog/search";
import { createCategory } from "@/server/catalog/taxonomy";
import { normalizeBarcode, parseMoneyText } from "@/server/domain/catalog";
import { can } from "@/server/domain/permissions";
import { getLocale } from "../../_lib/i18n";
import { messagesFor } from "@/messages";
import { loadShell } from "../_shell";
import { call, fail, metaFor } from "./_lib/call";
import { resolveStartDate, wholeNumber } from "./_lib/numbers";
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
          isTestData: input.isTestData === true,
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
  const alertDays = tracksExpiry && alert !== "" ? wholeNumber(alert) : null;
  if (tracksExpiry && alert !== "" && alertDays === null) return fail("BAD_NUMBER");
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
        { id: str(input.id), expectedVersion: Number(input.expectedVersion), name: str(input.name), quantityScale: wholeNumber(input.quantityScale) ?? Number.NaN },
        m,
      ),
    ack,
  );
}

export async function archiveUnitAction(key: unknown, input: Wire): Promise<UiResult<Done>> {
  return call(key, (m) => archiveUnit({ id: str(input.id), expectedVersion: Number(input.expectedVersion) }, m), ack);
}

export async function addUnitAction(key: unknown, input: Wire): Promise<UiResult<Done>> {
  const factor = wholeNumber(input.factor);
  if (factor === null || factor < 2) return fail("BAD_FACTOR");
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

/** A price on the DEFAULT list. `startsAt` is a Baghdad calendar date (YYYY-MM-DD): empty or today is now, a later day is scheduled, a past day is refused (BAD_DATE). */
export async function setPriceAction(key: unknown, input: Wire): Promise<UiResult<Done>> {
  const amount = parseAmount(input.amount, input.currency);
  if (amount === null || amount === "BAD") return fail("BAD_PRICE");
  const start = resolveStartDate(input.startsAt, new Date());
  if (start.kind === "bad") return fail("BAD_DATE");
  const validFrom = start.kind === "at" ? start.at : undefined;
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

export async function unarchiveProductAction(key: unknown, input: Wire): Promise<UiResult<Done>> {
  return call(key, (m) => unarchiveProduct({ id: str(input.id), expectedVersion: Number(input.expectedVersion) }, m), ack);
}

/** A new variant from option name/value pairs (size L, colour blue), an optional SKU and its base unit. */
export async function addVariantAction(key: unknown, input: Wire): Promise<UiResult<Done>> {
  const locale = await getLocale();
  const pairs = Array.isArray(input.options) ? (input.options as unknown[]) : [];
  const options: Record<string, string> = {};
  for (const pair of pairs) {
    const p = (pair ?? {}) as Wire;
    const k = str(p.key).trim();
    const v = str(p.value).trim();
    if (k === "" && v === "") continue;
    if (k === "" || v === "" || Object.hasOwn(options, k)) return fail("BAD_OPTIONS");
    options[k] = v;
  }
  if (Object.keys(options).length === 0) return fail("BAD_OPTIONS");
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
  const sku = str(input.sku).trim();
  return call(
    key,
    (m) =>
      addVariant(
        {
          productId: str(input.productId),
          options,
          ...(sku !== "" ? { sku } : {}),
          baseUnit: { name: str(input.unitName).trim() || messagesFor(locale).catalog.defaultUnit, barcodes: code ? [code] : [] },
          ...(amount !== null ? { price: { currency: input.currency, amountMinor: amount } } : {}),
        },
        m,
      ),
    ack,
  );
}

// ---------------------------------------------------------------------------------------------
// Barcode scan (src/server/intake/barcode.ts). The camera decodes in the browser; these only look
// the code up, read a photo with AI when the browser could not, and list an item's units for
// linking (which itself is addBarcodeAction above). Answers carry names, ids, SKU and flags only.

/** At most this much base64 for one barcode photo (made smaller in the browser; the server allows 5 MB of bytes). */
const MAX_SCAN_BASE64 = 4 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** What a scanned or typed code belongs to here (no AI, not behind the AI switch). */
export async function scanLookupAction(code: unknown): Promise<UiResult<BarcodeRead>> {
  let normalized: string;
  try {
    normalized = normalizeBarcode(str(code));
  } catch {
    return fail("BAD_BARCODE");
  }
  return call("", (m) => lookupBarcode({ code: normalized }, m));
}

/**
 * Reads a barcode's digits from one photo with AI (the browser could not decode it). `key` is this
 * attempt's idempotency key: the screen sends the same photo again with the same key after a lost
 * answer, and the server then answers from the first attempt (it may wait up to a minute for it).
 */
export async function scanReadImageAction(key: unknown, input: Wire): Promise<UiResult<BarcodeRead>> {
  const data = input.data;
  if (typeof data !== "string" || data.length === 0 || data.length > MAX_SCAN_BASE64 || !BASE64.test(data)) return fail("INVALID_INPUT");
  const image = { contentType: str(input.contentType).slice(0, 64), bytes: new Uint8Array(Buffer.from(data, "base64")) };
  return call(key, (m) => readBarcodeFromImage({ image }, m));
}

export type ScanItem = {
  productId: string;
  variantId: string;
  nameAr: string;
  nameCkb: string | null;
  nameEn: string | null;
  sku: string;
  /** Active units, the base unit first. */
  units: { id: string; name: string; isBase: boolean }[];
};

/** One item picked to link a code to, with the units a code can go on. */
export async function scanItemAction(productId: unknown, variantId: unknown): Promise<UiResult<ScanItem>> {
  const pid = optId(productId);
  const vid = optId(variantId);
  if (!pid || !vid || pid.length > 64 || vid.length > 64) return fail("NOT_FOUND");
  const product = await call("", (m) => getProduct({ id: pid }, m));
  if (!product.ok) return product;
  const p = product.value;
  const variant = p.variants.find((v) => v.id === vid);
  if (!variant) return fail("NOT_FOUND");
  const units = variant.units
    .filter((u) => u.archivedAt === null)
    .sort((a, b) => Number(b.isBase) - Number(a.isBase))
    .map((u) => ({ id: u.id, name: u.name, isBase: u.isBase }));
  return { ok: true, value: { productId: p.id, variantId: variant.id, nameAr: p.nameAr, nameCkb: p.nameCkb, nameEn: p.nameEn, sku: variant.sku, units } };
}
