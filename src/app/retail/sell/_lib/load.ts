import { redirect } from "next/navigation";
import { can } from "@/server/domain/permissions";
import type { ActionMeta } from "@/server/framework/action";
import type { ErrorCode } from "@/server/framework/errors";
import { requireShell, type Shell } from "../../_shell";

/** The till's gate: the business must accept the user, a branch must be chosen, and the role must sell. */
export async function tillGate(): Promise<{ ok: true; shell: Shell; meta: ActionMeta } | { ok: false; code: ErrorCode }> {
  const shell = await requireShell();
  if (!shell.options) redirect("/retail/select");
  if (!shell.options.ok) return { ok: false, code: shell.options.code };
  if (!shell.branch) redirect("/retail/select");
  if (!can(shell.options.value.role, "sale.create")) return { ok: false, code: "FORBIDDEN" };
  return { ok: true, shell, meta: { userId: shell.user.id, businessId: shell.businessId!, idempotencyKey: "" } };
}
