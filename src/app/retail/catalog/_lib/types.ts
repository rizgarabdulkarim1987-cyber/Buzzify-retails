import type { ErrorCode } from "@/server/framework/errors";

/** Refusals only the UI layer produces (text it could not turn into a value), besides the actions' own codes. */
export type UiCode = ErrorCode | "INTERNAL" | "BAD_BARCODE" | "BAD_PRICE" | "BAD_NAME" | "BAD_FACTOR" | "BAD_DATE" | "BAD_NUMBER" | "BAD_OPTIONS";

export type UiFailure = { code: UiCode; details?: Readonly<Record<string, string | null>> };
export type UiResult<T> = { ok: true; value: T } | ({ ok: false } & UiFailure);

export type Currency = "IQD" | "USD";

/** One search hit as the browser receives it (money as a digit string). */
export type HitDto = {
  productId: string;
  variantId: string;
  nameAr: string;
  nameCkb?: string;
  nameEn?: string;
  sku: string;
  tracksExpiry: boolean;
  soldByWeight: boolean;
  archived: boolean;
  isTestData: boolean;
  matchedBarcode?: string;
  matchedUnitName?: string;
  unitPrice?: { currency: Currency; amountMinor: string };
};
export type SearchPage = { items: HitDto[]; nextCursor: string | null };

export type CategoryDto = { id: string; parentId: string | null; nameAr: string; nameCkb: string | null; nameEn: string | null };
export type BrandDto = { id: string; nameAr: string; nameCkb: string | null; nameEn: string | null };

export type NamedDto = { id: string; nameAr: string; nameCkb: string | null; nameEn: string | null };

export type PriceCellDto = {
  /** The newest row of this currency on the DEFAULT list (the stale-edit guard), null when there is none. */
  latestId: string | null;
  current: { amountMinor: string } | null;
  scheduled: { amountMinor: string; validFrom: string } | null;
  /** factor x the base unit's current price, for a larger unit; null for the base unit or without a base price. */
  suggestedMinor: string | null;
};
export type BarcodeDto = { id: string; code: string; archived: boolean; version: number };
export type UnitDto = {
  id: string;
  name: string;
  factor: number;
  isBase: boolean;
  quantityScale: number;
  archived: boolean;
  version: number;
  barcodes: BarcodeDto[];
  prices: Partial<Record<Currency, PriceCellDto>>;
};
export type VariantDto = {
  id: string;
  sku: string;
  options: Record<string, string> | null;
  archived: boolean;
  version: number;
  units: UnitDto[];
};
export type ProductDto = {
  id: string;
  version: number;
  nameAr: string;
  nameCkb: string | null;
  nameEn: string | null;
  category: NamedDto | null;
  brand: NamedDto | null;
  tracksExpiry: boolean;
  expiryAlertDays: number | null;
  soldByWeight: boolean;
  archived: boolean;
  /** A trial item (setup wizard). */
  isTestData: boolean;
  variants: VariantDto[];
};
