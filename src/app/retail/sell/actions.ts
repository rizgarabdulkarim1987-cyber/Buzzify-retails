"use server";

import { currentUnitPrices, listSellItems } from "@/server/sales/catalog";
import { createSale } from "@/server/sales/sales";
import { closeShift, openShift } from "@/server/sales/shifts";
import { loadShell } from "../_shell";
import { call, fail } from "../catalog/_lib/call";
import type { ReceiptDto, SellItemDto, SellResult } from "./_lib/cart";
import { itemDto, receiptDto, shiftDto } from "./_lib/dto";

/*
 * The till's server actions. Who sells, in which business, branch and terminal comes from the
 * session (never the browser); money arrives as digit strings of minor units and the actions
 * themselves validate everything. Every write carries the attempt's idempotency key: a retry with
 * the same key replays the first answer instead of selling twice.
 */

const isText = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** Opens the user's shift in the shell's branch (and terminal, when one is chosen). */
export async function openShiftAction(key: unknown, openingCashMinor: unknown): Promise<SellResult<{ shiftId: string }>> {
  const shell = await loadShell();
  if (!shell?.branch) return fail("FORBIDDEN");
  if (typeof openingCashMinor !== "string") return fail("INVALID_INPUT");
  return call(
    key,
    (m) => openShift({ branchId: shell.branch!.id, terminalId: shell.terminal?.id ?? null, openingCashMinor }, m),
    (v) => ({ shiftId: v.id }),
  );
}

export async function closeShiftAction(
  key: unknown,
  input: { shiftId: unknown; countedCashMinor: unknown; note: unknown; expectedVersion: unknown },
): Promise<SellResult<{ differenceMinor: string; shift: ReturnType<typeof shiftDto> }>> {
  return call(
    key,
    (m) => closeShift(input, m),
    (v) => ({ differenceMinor: v.differenceMinor.toString(), shift: shiftDto(v) }),
  );
}

/** Tiles: by category, or by a typed text / scanned barcode. */
export async function sellItemsAction(input: { query: unknown; categoryId: unknown; locationId: unknown }): Promise<SellResult<SellItemDto[]>> {
  const query = typeof input.query === "string" ? input.query.slice(0, 100) : "";
  const categoryId = isText(input.categoryId, 64) ? input.categoryId : null;
  const locationId = isText(input.locationId, 64) ? input.locationId : null;
  return call("", (m) => listSellItems({ query, categoryId, locationId }, m), (v) => v.map(itemDto));
}

/** Current prices of the cart's units (after PRICE_CHANGED). */
export async function pricesAction(unitIds: unknown): Promise<SellResult<Record<string, string | null>>> {
  if (!Array.isArray(unitIds) || unitIds.length === 0) return fail("INVALID_INPUT");
  return call(
    "",
    (m) => currentUnitPrices({ unitIds }, m),
    (v) => Object.fromEntries(Object.entries(v).map(([k, p]) => [k, p === null ? null : p.toString()])),
  );
}

/** Rings up the cart. The attempt key is both the idempotency key and the sale key. */
export async function createSaleAction(
  key: unknown,
  input: { lines: unknown; payments: unknown; expectedTotalMinor: unknown },
): Promise<SellResult<ReceiptDto>> {
  if (!isText(key)) return fail("INVALID_INPUT");
  return call(key, (m) => createSale({ saleKey: key, lines: input.lines, payments: input.payments, expectedTotalMinor: input.expectedTotalMinor }, m), receiptDto);
}
