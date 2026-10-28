/*
 * Whether the user may switch to another branch now. Pure: no database, no I/O.
 *
 * Switching is refused while the session holds an open shift or unsent sale drafts, so nothing
 * open in one branch silently follows the user into another (and no stock moves implicitly).
 * Drafts and shifts arrive in R3; until then the shell passes { openDrafts: 0, openShift: false }.
 */

export type BranchSwitchState = { openDrafts: number; openShift: boolean };

export type BranchSwitchDecision = { allowed: true } | { allowed: false; reason: "OPEN_DRAFTS" | "OPEN_SHIFT" };

export function canSwitchBranch(state: BranchSwitchState): BranchSwitchDecision {
  // The shift first: closing it is the bigger step, and it usually settles the drafts too.
  if (state.openShift !== false) return { allowed: false, reason: "OPEN_SHIFT" };
  // Fail closed: anything but a whole, finite zero counts as open drafts.
  if (state.openDrafts !== 0) return { allowed: false, reason: "OPEN_DRAFTS" };
  return { allowed: true };
}
