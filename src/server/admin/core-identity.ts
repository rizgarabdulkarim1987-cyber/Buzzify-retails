import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { auth } from "@/server/auth/auth";
import { CoreClientError, getCoreClient } from "@/server/core/client";
import { db } from "@/server/db";
import { RuleError } from "@/server/framework/errors";

/*
 * Staff invitation identity. Before a staff email is added to a business that is linked to Studio
 * (coreBusinessId), Studio is asked to ensure an identity for it, and the returned coreUserId may be
 * linked to the existing local user. Base client on purpose (User is outside tenant scope), as in
 * core-handoff.ts. Only the email, the user's display name and the opaque coreUserId travel.
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
 * - Studio says the email is verified but there is no local user: one is created here (lowercased email,
 *   name from the email's local part, emailVerified, coreUserId, no password), so the add can proceed and
 *   the person signs in through Studio. Unverified and no local user: nothing is created (USER_NOT_FOUND).
 * - Two local users match the email ignoring case: nothing is linked.
 * - Standalone business (no coreBusinessId) or no Studio configured: does nothing at all.
 * - Studio unreachable or malformed: RuleError CORE_UNAVAILABLE (retryable); no silent fallback.
 * - The Studio id already belongs to another local user (unique violation): IDENTITY_CONFLICT.
 */

const MAX_EMAILS = 50;

/** A local user for a Studio-verified email: lowercased email, name from its local part, no Account row. */
async function createLinkedUser(email: string, coreUserId: string): Promise<void> {
  const ctx = await auth.$context;
  const id = ctx.generateId({ model: "user" }) || randomUUID();
  const name = email.split("@")[0]!.slice(0, 120) || email;
  try {
    await db.user.create({ data: { id, email, name, emailVerified: true, coreUserId } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new RuleError("IDENTITY_CONFLICT");
    throw e;
  }
}

export async function ensureStaffIdentities(businessId: string, emails: readonly string[]): Promise<void> {
  const client = getCoreClient();
  if (!client) return;
  const business = await db.rtBusiness.findUnique({ where: { id: businessId }, select: { coreBusinessId: true } });
  if (!business?.coreBusinessId) return;

  const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e !== ""))].slice(0, MAX_EMAILS);
  for (const email of wanted) {
    const matches = await db.user.findMany({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true, name: true, coreUserId: true, platformAdmin: { select: { userId: true } } },
      take: 2,
    });
    // Two local accounts differ only by the case of the email: ambiguous, so nothing is linked (as in the handoff).
    if (matches.length > 1) continue;
    const local = matches[0];
    // Already linked, or a platform admin: nothing to link, so Studio is not asked.
    if (local && (local.coreUserId !== null || local.platformAdmin !== null)) continue;
    let identity: { coreUserId: string; emailVerified: boolean };
    try {
      identity = await client.ensureIdentity(email, local?.name);
    } catch (e) {
      if (e instanceof CoreClientError) throw new RuleError("CORE_UNAVAILABLE");
      throw e;
    }
    if (identity.emailVerified !== true) continue; // unverified: nothing is linked or created; the verified handoff links later
    if (!local) {
      // Studio vouches for this email and no local account exists: create it (no password, so it signs in through Studio).
      await createLinkedUser(email, identity.coreUserId);
      continue;
    }
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
