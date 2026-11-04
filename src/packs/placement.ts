import { getPack, packById, type PackId, type PackManifest } from "./index";

/*
 * Which of a user's businesses an address may show. A product address (PACK_HOSTS) shows only that
 * product's businesses; the shared address (APP_URL) shows all of them, each in its own pack.
 */

type Placed<M> = {
  /** The businesses this address may open. */
  memberships: M[];
  /**
   * Set when the user has businesses but none of this address's product: where to send them (the
   * home of their product's own address), or null when that product has no address (not-available page).
   */
  misplaced: { redirectTo: string | null } | null;
};

export function placeMemberships<M extends { activityType: string }>(
  hostPack: PackId | null,
  all: readonly M[],
  originOf: (pack: PackId) => string | null,
): Placed<M> {
  if (hostPack === null) return { memberships: [...all], misplaced: null };
  const memberships = all.filter((m) => getPack(m.activityType).id === hostPack);
  if (all.length === 0 || memberships.length > 0) return { memberships, misplaced: null };
  const theirs = getPack(all[0]!.activityType);
  const origin = originOf(theirs.id);
  return { memberships, misplaced: { redirectTo: origin ? `${origin}${theirs.home}` : null } };
}

/** The product shown: the address's own, else the shown business's, else none (neutral). */
export function shownPack(hostPack: PackId | null, shownActivity: string | null | undefined): PackManifest | null {
  if (hostPack !== null) return packById(hostPack);
  return shownActivity === undefined || shownActivity === null ? null : getPack(shownActivity);
}
