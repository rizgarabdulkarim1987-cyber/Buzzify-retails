import { redirect } from "next/navigation";
import { catalogContext, type CatalogContext } from "@/server/catalog/context";
import type { ActionMeta } from "@/server/framework/action";
import type { ErrorCode } from "@/server/framework/errors";
import { can } from "@/server/domain/permissions";
import { requireShell } from "../../_shell";

export type CatalogAccess =
  | { ok: true; meta: ActionMeta; context: CatalogContext; canManage: boolean; canPrice: boolean }
  | { ok: false; code: ErrorCode };

/**
 * The signed-in user's footing in the catalog of the business they work in: who they are, their
 * role and the business currencies. Not a gate: the actions check every permission themselves;
 * this only decides which controls the page draws (and a refusal state when the business says no).
 */
export async function loadCatalogAccess(): Promise<CatalogAccess> {
  const shell = await requireShell();
  if (!shell.businessId) redirect("/retail/select");
  const meta: ActionMeta = { userId: shell.user.id, businessId: shell.businessId, idempotencyKey: "" };
  const context = await catalogContext({}, meta);
  if (!context.ok) return { ok: false, code: context.code };
  return {
    ok: true,
    meta,
    context: context.value,
    canManage: can(context.value.role, "catalog.manage"),
    canPrice: can(context.value.role, "price.change"),
  };
}
