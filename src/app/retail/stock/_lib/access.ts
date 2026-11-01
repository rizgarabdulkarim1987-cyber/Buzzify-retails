import { redirect } from "next/navigation";
import type { ActionMeta } from "@/server/framework/action";
import { currentGate } from "@/server/framework/business-info";
import type { ErrorCode } from "@/server/framework/errors";
import { stockContext, type StockContext } from "@/server/stock/queries";
import { requireShell } from "../../_shell";

export type StockAccess =
  | { ok: true; meta: ActionMeta; context: StockContext; /** The business accepts no writes now (READ_ONLY): adjust buttons are drawn disabled. */ readOnly: boolean }
  | { ok: false; code: ErrorCode };

/**
 * The signed-in user's footing in the stock screens: who they are and what the stock context says
 * (role, permissions, currency). Not a gate: every action checks its own permission; this only
 * decides what the page draws, and a refusal state when the business says no.
 */
export async function loadStockAccess(): Promise<StockAccess> {
  const shell = await requireShell();
  if (!shell.businessId) redirect("/retail/select");
  const meta: ActionMeta = { userId: shell.user.id, businessId: shell.businessId, idempotencyKey: "" };
  const context = await stockContext({}, meta);
  if (!context.ok) return { ok: false, code: context.code };
  const readOnly = (await currentGate(shell.businessId)) !== "FULL";
  return { ok: true, meta, context: context.value, readOnly };
}
