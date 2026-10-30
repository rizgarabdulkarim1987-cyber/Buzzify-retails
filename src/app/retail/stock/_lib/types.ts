import type { UiCode } from "../../catalog/_lib/types";

/*
 * What the stock screens receive from the server: quantities (base unit x 1000) and money (minor
 * units of the business currency) as digit strings, dates as ISO text. The value keys exist only
 * when the server returned them (cost.view); a screen never draws a value cell without one.
 */

export type ExpiryState = "NONE" | "OK" | "SOON" | "EXPIRED";
export type DocKind = "OPENING" | "RECEIPT" | "ADJUSTMENT" | "WRITE_OFF" | "REVERSAL";
export type Currency = "IQD" | "USD";

export type BreakdownDto = { parts: { name: string; count: string }[]; remainder: string };

export type StockRowDto = {
  productId: string;
  variantId: string;
  nameAr: string;
  nameCkb?: string;
  nameEn?: string;
  sku: string;
  qty: string;
  availableQty: string;
  breakdown: BreakdownDto;
  nearestExpiry: string | null;
  status: ExpiryState;
  archived?: true;
  valueMinor?: string;
  avgUnitCostMinor?: string;
};
export type StockPage = { rows: StockRowDto[]; nextCursor: string | null };

export type MovementDto = {
  id: string;
  createdAt: string;
  documentKind: DocKind;
  documentNumber: number | null;
  batchCode: string | null;
  qtyDelta: string;
  qtyAfter: string;
  valueDeltaMinor?: string;
  valueAfterMinor?: string;
};
export type MovementPage = { rows: MovementDto[]; nextCursor: string | null };

export type BatchDto = { batchId: string | null; code: string | null; expiry: string | null; status: ExpiryState; qty: string };

/** What the adjust dialog needs about one variant, read fresh each time it opens. */
export type AdjustSetup = {
  productId: string;
  variantId: string;
  nameAr: string;
  nameCkb: string | null;
  nameEn: string | null;
  sku: string;
  trackingMode: "NONE" | "BATCH" | "SERIAL";
  tracksExpiry: boolean;
  isTestData: boolean;
  /** The product or the variant is archived: stock can only go out. */
  archived: boolean;
  units: { id: string; name: string; factor: number; quantityScale: number; isBase: boolean }[];
  /**
   * Every batch of the variant, also the used-up ones at qty 0 (an IN can go back into them), and the
   * no-batch row when it holds stock (batchId null); earliest expiry first.
   */
  batches: BatchDto[];
};

/** costUnknown: the IN was valued at zero (no stock to take an average from); only for cost.view holders. */
export type AdjustDone = { documentId: string; number: number; costUnknown?: true };

export type AdjustMode = "IN" | "OUT" | "WRITE_OFF";
export type AdjustReason = "DAMAGED" | "EXPIRED" | "LOST" | "COUNT_FIX" | "OTHER";

/** Refusals of the stock screens: the actions' codes plus the ones only the UI makes. */
export type StockUiCode = UiCode | "BAD_QUANTITY";
export type StockFailure = { code: StockUiCode; details?: Readonly<Record<string, string | null>> };
export type StockResult<T> = { ok: true; value: T } | ({ ok: false } & StockFailure);
