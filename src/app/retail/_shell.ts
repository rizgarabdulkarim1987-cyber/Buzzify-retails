import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { PackManifest } from "@/packs";
import { packOrigin, resolveHost } from "@/packs/hosts";
import { placeMemberships, shownPack } from "@/packs/placement";
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
  /**
   * The product shown: the pack of the host (on a product address) or of the business shown (on
   * the shared address); null on the shared address before a business is chosen.
   */
  pack: PackManifest | null;
  /**
   * Set when every business of the user belongs to another product than this address's: where to
   * send them (that product's address, or null when PACK_HOSTS has none: the not-available page).
   */
  misplaced: { redirectTo: string | null } | null;
};

/** Where a misplaced user is sent when their product has no address of its own. */
export const UNAVAILABLE_PATH = "/unavailable";

/** The scoped options of one business for this user, once per request. */
export const optionsFor = cache((userId: string, businessId: string) =>
  shellOptions({}, { userId, businessId, idempotencyKey: "" }),
);

/** Everything the shell needs for this request (null when signed out). Cached per request. */
export const loadShell = cache(async (): Promise<Shell | null> => {
  const requestHeaders = await headers();
  const user = await getSessionUser(requestHeaders);
  if (!user) return null;
  const host = resolveHost(requestHeaders);
  // On a product address only that product's businesses exist; on the shared address, all of them.
  const { memberships, misplaced } = placeMemberships(host.packId, await listMemberships(user.id), packOrigin);
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
  const pack = shownPack(host.packId, memberships.find((m) => m.businessId === businessId)?.activityType);
  return { user, memberships, saved, businessId, options, branch, terminal, pack, misplaced };
});

/**
 * The shell, or a redirect: to sign-in when signed out, and away from a product address that is
 * not the user's product (to their own product's address, or the not-available page).
 */
export async function requireShell(): Promise<Shell> {
  const shell = await loadShell();
  if (!shell) redirect("/login");
  if (shell.misplaced) redirect(shell.misplaced.redirectTo ?? UNAVAILABLE_PATH);
  return shell;
}
