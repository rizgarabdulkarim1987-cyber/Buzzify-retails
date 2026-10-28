import { addBaghdadDays } from "./baghdad-time";

/** What a business may do right now. FULL: everything. READ_ONLY: reads and exports. CLOSED: nothing. */
export type GateMode = "FULL" | "READ_ONLY" | "CLOSED";

export type SubscriptionStatus = "TRIAL" | "ACTIVE" | "GRACE" | "EXPIRED" | "CANCELLED";

export type GateSubscription = {
  status: SubscriptionStatus;
  trialEndsAt?: Date | null;
  currentPeriodEnd: Date;
  graceDays: number;
  cancelledAt?: Date | null;
};

const DAY_MS = 86_400_000;

/**
 * The gate, derived from dates (no cron flips statuses); only CANCELLED is trusted from the stored status.
 *
 * - No subscription: CLOSED.
 * - CANCELLED: READ_ONLY from cancelledAt for retentionDays, then CLOSED. Never FULL.
 * - Otherwise, with periodEnd = trialEndsAt (TRIAL, falling back to currentPeriodEnd) or currentPeriodEnd:
 *   FULL until graceEnd = start of the Baghdad day containing periodEnd + (graceDays + 1) days
 *   (the period end itself and the grace days are both FULL), READ_ONLY until graceEnd + retentionDays, then CLOSED.
 */
export function gateFor(sub: GateSubscription | null, now: Date, retentionDays = 90): GateMode {
  if (sub === null) return "CLOSED";
  const t = now.getTime();

  if (sub.status === "CANCELLED") {
    const from = (sub.cancelledAt ?? sub.currentPeriodEnd).getTime();
    return t < from + retentionDays * DAY_MS ? "READ_ONLY" : "CLOSED";
  }

  const periodEnd = sub.status === "TRIAL" ? (sub.trialEndsAt ?? sub.currentPeriodEnd) : sub.currentPeriodEnd;
  const graceEnd = addBaghdadDays(periodEnd, sub.graceDays + 1).getTime();
  if (t < graceEnd) return "FULL";
  return t < graceEnd + retentionDays * DAY_MS ? "READ_ONLY" : "CLOSED";
}
