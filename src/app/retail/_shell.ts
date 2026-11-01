import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser, type SessionUser } from "@/server/auth/auth";
import type { Result } from "@/server/framework/errors";
import { listMemberships, type Membership } from "@/server/framework/memberships";
import { shellOptions, type ShellBranch, type ShellOptions, type ShellTerminal } from "@/server/shell/options";
import { WORKPLACE_COOKIE, decodeWorkplace, type Workplace } from "../_lib/workplace";

export type Shell = {
  user: SessionUser;
  memberships: Membership[];
  /** The workplace cookie as stored (not yet checked). */
  saved: Workplace | null;
  /** The business the header shows: the saved one, or the only membership. */
  businessId: string | null;
  /** The scoped options of that business (null when there is no business to show). */
  options: Result<ShellOptions> | null;
  /** The saved branch and terminal, only when the scoped options still contain them. */
  branch: ShellBranch | null;
  terminal: ShellTerminal | null;
};

/** The scoped options of one business for this user, once per request. */
export const optionsFor = cache((userId: string, businessId: string) =>
  shellOptions({}, { userId, businessId, idempotencyKey: "" }),
);

/** Everything the shell needs for this request (null when signed out). Cached per request. */
export const loadShell = cache(async (): Promise<Shell | null> => {
  const user = await getSessionUser(await headers());
  if (!user) return null;
  const memberships = await listMemberships(user.id);
  const saved = decodeWorkplace((await cookies()).get(WORKPLACE_COOKIE)?.value);
  const isMember = (id: string | undefined) => memberships.some((m) => m.businessId === id);

  const businessId = isMember(saved?.businessId)
    ? saved!.businessId
    : memberships.length === 1
      ? memberships[0]!.businessId
      : null;
  const options = businessId ? await optionsFor(user.id, businessId) : null;

  let branch: ShellBranch | null = null;
  let terminal: ShellTerminal | null = null;
  if (options?.ok && saved && saved.businessId === businessId) {
    branch = options.value.branches.find((b) => b.id === saved.branchId) ?? null;
    terminal = branch?.terminals.find((t) => t.id === saved.terminalId) ?? null;
  }
  return { user, memberships, saved, businessId, options, branch, terminal };
});

/** The shell, or a redirect to sign-in. */
export async function requireShell(): Promise<Shell> {
  const shell = await loadShell();
  if (!shell) redirect("/login");
  return shell;
}
