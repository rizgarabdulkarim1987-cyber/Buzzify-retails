import { getProduct } from "@/server/catalog/products";
import { can } from "@/server/domain/permissions";
import type { RtRole } from "@/generated/prisma/enums";
import type { ActionMeta } from "@/server/framework/action";
import { getAiStatus, type AiStatus } from "@/server/intake/quota";
import { getIntake } from "@/server/intake/receipts";
import { getVariantStock } from "@/server/stock/queries";
import { itemInfoOf } from "../../../_lib/receipt-load";
import type { ItemInfo } from "../../../_lib/receipt-rules";
import type { StockFailure, StockResult } from "../../../_lib/types";
import { intakeDto, type IntakeDto, type PhotoRole } from "./rules";

/*
 * Server-side reads of the receipt-photo screens: the intake as the browser receives it (through
 * intakeDto: prices only for cost.view, which getIntake itself requires on every read) with every
 * item its lines name, and the role's footing for the photo screens.
 */

type Product = Extract<Awaited<ReturnType<typeof getProduct>>, { ok: true }>["value"];

const refused = (r: { code: StockFailure["code"]; details?: StockFailure["details"] }): { ok: false } & StockFailure =>
  r.details ? { ok: false, code: r.code, details: r.details } : { ok: false, code: r.code };

/** What a role may do on the photo screens (the actions decide again). */
export function photoRole(role: RtRole): PhotoRole & { canCreateItems: boolean } {
  return {
    canUseAi: can(role, "ai.use"),
    canReceive: can(role, "stock.receive"),
    seesCost: can(role, "cost.view"),
    isOwner: can(role, "ai.consent"),
    canCreateItems: can(role, "catalog.manage"),
  };
}

/**
 * The AI status, or UNAVAILABLE when it could not be read (a refusal or an error). Callers load it
 * only for a role that may use the photo intake, so this is a failure to retry, never "switched off".
 */
export async function loadAiStatus(meta: ActionMeta): Promise<AiStatus | "UNAVAILABLE"> {
  try {
    const s = await getAiStatus({}, meta);
    return s.ok ? s.value : "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}

/** Item details for variant ids (each product read once); a variant that cannot be read is left out. */
export async function loadItems(variantIds: Iterable<string>, meta: ActionMeta): Promise<Record<string, ItemInfo>> {
  const items: Record<string, ItemInfo> = {};
  const products = new Map<string, Product>();
  for (const variantId of new Set(variantIds)) {
    const stock = await getVariantStock({ variantId }, meta);
    if (!stock.ok) continue;
    let product = products.get(stock.value.productId);
    if (!product) {
      const read = await getProduct({ id: stock.value.productId }, meta);
      if (!read.ok) continue;
      product = read.value;
      products.set(product.id, product);
    }
    const item = itemInfoOf(product, variantId);
    if (item) items[variantId] = item;
  }
  return items;
}

export type IntakeReview = { intake: IntakeDto; items: Record<string, ItemInfo> };

/** One intake for its screen, with the items its lines name. */
export async function loadIntakeReview(intakeId: string, meta: ActionMeta, seesCost: boolean): Promise<StockResult<IntakeReview>> {
  const read = await getIntake({ intakeId }, meta);
  if (!read.ok) return refused(read);
  const intake = intakeDto(read.value, seesCost);
  const ids = intake.lines.flatMap((l) => (l.variantId && !l.discarded ? [l.variantId] : []));
  return { ok: true, value: { intake, items: await loadItems(ids, meta) } };
}
