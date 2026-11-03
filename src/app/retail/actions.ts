"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/server/auth/auth";
import { canSwitchBranch } from "@/server/domain/branch-switch";
import { myOpenShift } from "@/server/sales/shifts";
import { shellOptions } from "@/server/shell/options";
import { WORKPLACE_COOKIE, WORKPLACE_COOKIE_OPTIONS, decodeWorkplace, encodeWorkplace, isId } from "../_lib/workplace";

function backToSelect(businessId: string | null, error: string): never {
  const q = new URLSearchParams({ error });
  if (businessId) q.set("business", businessId);
  redirect(`/retail/select?${q.toString()}`);
}

/**
 * Chooses the business, branch and (optional) terminal to work in. Everything is re-checked
 * against the actor's scoped options: a branch or terminal the user may not use is refused.
 * Leaving the current branch goes through canSwitchBranch: an open shift of the user in that
 * branch refuses the switch (close it first).
 */
export async function selectWorkplace(formData: FormData): Promise<void> {
  const userId = await getSessionUserId(await headers());
  if (!userId) redirect("/login");

  const businessId = formData.get("business");
  const branchId = formData.get("branch");
  const terminalRaw = formData.get("terminal");
  const terminalId = terminalRaw === null || terminalRaw === "" ? null : terminalRaw;
  if (!isId(businessId) || !isId(branchId) || (terminalId !== null && !isId(terminalId))) {
    backToSelect(isId(businessId) ? businessId : null, "INVALID_INPUT");
  }

  const options = await shellOptions({}, { userId, businessId, idempotencyKey: "" });
  if (!options.ok) backToSelect(businessId, options.code);
  const branch = options.value.branches.find((b) => b.id === branchId);
  const terminalOk = terminalId === null || branch?.terminals.some((t) => t.id === terminalId);
  if (!branch || !terminalOk) backToSelect(businessId, "FORBIDDEN");

  const jar = await cookies();
  const current = decodeWorkplace(jar.get(WORKPLACE_COOKIE)?.value);
  if (current && (current.businessId !== businessId || current.branchId !== branchId)) {
    // The user's open shift in the branch being left blocks the switch (draft sales do not exist yet:
    // the till keeps its cart and held carts in the browser).
    const mine = await myOpenShift({}, { userId, businessId: current.businessId, idempotencyKey: "" });
    const openShift = mine.ok && mine.value !== null && mine.value.shift.branchId === current.branchId;
    const decision = canSwitchBranch({ openDrafts: 0, openShift });
    if (!decision.allowed) backToSelect(businessId, decision.reason);
  }

  jar.set(WORKPLACE_COOKIE, encodeWorkplace({ businessId, branchId, terminalId }), WORKPLACE_COOKIE_OPTIONS);
  redirect("/retail/home");
}
