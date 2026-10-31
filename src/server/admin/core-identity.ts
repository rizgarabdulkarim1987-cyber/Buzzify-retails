import { Prisma } from "@/generated/prisma/client";
import { CoreClientError, getCoreClient } from "@/server/core/client";
import { db } from "@/server/db";
import { RuleError } from "@/server/framework/errors";

/*
 * Staff invitation identity. Before a staff email is added to a business that is linked to Studio
 * (coreBusinessId), Studio is asked to ensure an identity for it, and the returned coreUserId may be
 * linked to the existing local user. Base client on purpose (User is outside tenant scope), as in
 * core-handoff.ts. Only the email, the user's display name and the opaque coreUserId travel; nothing
 * is stored for an email that has no local user yet.
 *
 * Linking follows the sign-in handoff's takeover guards (core-handoff.ts): a local user is linked
 * only when Studio says the email is verified (emailVerified === true), the user is not a platform
 * admin, and has no coreUserId yet (guarded update). Otherwise nothing is linked and the staff add
 * proceeds as today (the verified handoff links later). A user who already has a coreUserId, and a
 * platform admin, are skipped without calling Studio at all, so a replay never depends on Studio.
 *
 * Runs from the step-5 precondition: input is already validated (zod), the caller's permission and
 * the business gate are already checked. Per-entry checks that need the transaction (role
 * grantable, branches, duplicates) run later in the action and are not repeated here; that is safe
 * because a link is made only under the guards above, whatever happens to the add afterwards.
 *
 * - Standalone business (no coreBusinessId) or no Studio configured: does nothing at all.
 * - Studio unreachable or malformed: RuleError CORE_UNAVAILABLE (retryable); no silent fallback.
 * - The Studio id already belongs to another local user (unique violation): IDENTITY_CONFLICT.
 */

const MAX_EMAILS = 50;

export async function ensureStaffIdentities(businessId: string, emails: readonly string[]): Promise<void> {
  const client = getCoreClient();
  if (!client) return;
  const business = await db.rtBusiness.findUnique({ where: { id: businessId }, select: { coreBusinessId: true } });
  if (!business?.coreBusinessId) return;

  const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e !== ""))].slice(0, MAX_EMAILS);
  for (const email of wanted) {
    const local = await db.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true, name: true, coreUserId: true, platformAdmin: { select: { userId: true } } },
    });
    // Already linked, or a platform admin: nothing to link, so Studio is not asked.
    if (local && (local.coreUserId !== null || local.platformAdmin !== null)) continue;
    let identity: { coreUserId: string; emailVerified: boolean };
    try {
      identity = await client.ensureIdentity(email, local?.name);
    } catch (e) {
      if (e instanceof CoreClientError) throw new RuleError("CORE_UNAVAILABLE");
      throw e;
    }
    if (!local || identity.emailVerified !== true) continue; // no local user: nothing remembered; unverified: the handoff links later
    try {
      // Guarded: only a still-unlinked user is linked.
      const { count } = await db.user.updateMany({ where: { id: local.id, coreUserId: null }, data: { coreUserId: identity.coreUserId } });
      if (count !== 1) continue; // linked concurrently by someone else; leave it
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new RuleError("IDENTITY_CONFLICT");
      throw e;
    }
  }
}
