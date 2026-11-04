import type { SellCategory, SellItem } from "@/server/sales/catalog";
import type { SaleView } from "@/server/sales/sales";
import type { ShiftSummary } from "@/server/sales/shifts";
import type { CategoryDto, ReceiptDto, SellItemDto, ShiftDto } from "./cart";

/* What crosses the wire to the till: BigInt as digit strings, dates as ISO text. Cost never leaves the server. */

export const categoryDto = (c: SellCategory): CategoryDto => ({ id: c.id, nameAr: c.nameAr, nameCkb: c.nameCkb, nameEn: c.nameEn });

export const itemDto = (i: SellItem): SellItemDto => ({
  variantId: i.variantId,
  unitId: i.unitId,
  nameAr: i.nameAr,
  nameCkb: i.nameCkb,
  nameEn: i.nameEn,
  unitName: i.unitName,
  quantityScale: i.quantityScale,
  factor: i.factor,
  soldByWeight: i.soldByWeight,
  priceMinor: i.priceMinor === null ? null : i.priceMinor.toString(),
  currency: i.currency,
  onHand: i.onHand === null ? null : i.onHand.toString(),
  matchedBarcode: i.matchedBarcode,
  categoryId: i.categoryId,
});

export const shiftDto = (s: ShiftSummary): ShiftDto => ({
  id: s.shift.id,
  version: s.shift.version,
  openedAt: s.shift.openedAt.toISOString(),
  currency: s.shift.currency,
  openingCashMinor: s.shift.openingCashMinor.toString(),
  salesCount: s.salesCount,
  totalMinor: s.totalMinor.toString(),
  cashMinor: s.cashMinor.toString(),
  cardMinor: s.cardMinor.toString(),
  expectedCashMinor: s.expectedCashMinor.toString(),
});

export const receiptDto = (s: SaleView): ReceiptDto => ({
  saleId: s.saleId,
  number: s.number,
  saleKey: s.saleKey,
  currency: s.currency,
  totalMinor: s.totalMinor.toString(),
  paidMinor: s.paidMinor.toString(),
  changeMinor: s.changeMinor.toString(),
  postedAt: s.postedAt.toISOString(),
  lines: s.lines.map((l) => ({
    lineNo: l.lineNo,
    nameAr: l.nameAr,
    nameCkb: l.nameCkb,
    nameEn: l.nameEn,
    unitName: l.unitName,
    quantity: l.enteredQuantity,
    unitPriceMinor: l.unitPriceMinor.toString(),
    lineTotalMinor: l.lineTotalMinor.toString(),
  })),
  payments: s.payments.map((p) => ({ method: p.method, amountMinor: p.amountMinor.toString(), tenderedMinor: p.tenderedMinor.toString() })),
});
