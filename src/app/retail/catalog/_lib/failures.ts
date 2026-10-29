import type { Locale, Messages } from "@/messages";
import { pickName } from "../../../_lib/format";
import type { UiFailure } from "./types";

/**
 * The text for a refusal, in the interface language. Every ErrorCode already has its message in all
 * three languages (t.errors); the codes only the UI layer makes have their own catalog strings.
 */
export function failureMessage(t: Messages, failure: UiFailure): string {
  switch (failure.code) {
    case "INTERNAL":
      return t.internalError;
    case "BAD_BARCODE":
      return t.catalog.entry.badBarcode;
    case "BAD_PRICE":
      return t.catalog.entry.badPrice;
    case "BAD_NAME":
      return t.catalog.entry.nameRequired;
    case "BAD_FACTOR":
      return t.catalog.product.badFactor;
    case "BAD_NUMBER":
      return t.catalog.product.badNumber;
    case "BAD_OPTIONS":
      return t.catalog.product.badOptions;
    case "BAD_DATE":
      return t.catalog.product.badDate;
    default:
      return t.errors[failure.code];
  }
}

/** True when the browser should offer "reload" (somebody else changed the row, or it is gone). */
export function isStale(failure: UiFailure): boolean {
  return failure.code === "VERSION_CONFLICT" || failure.code === "NOT_FOUND";
}

/** The product that owns a taken barcode, when the refusal says so (BARCODE_TAKEN). */
export function ownerOfBarcode(failure: UiFailure, locale: Locale): { productId: string; name: string } | null {
  const d = failure.details;
  if (failure.code !== "BARCODE_TAKEN" || !d?.productId) return null;
  return { productId: d.productId, name: pickName(locale, { nameAr: d.productName ?? "", nameCkb: d.productNameCkb, nameEn: d.productNameEn }) };
}
