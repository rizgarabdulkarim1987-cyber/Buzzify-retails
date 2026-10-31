import { Prisma } from "@/generated/prisma/client";
import { CoreClientError, getCoreClient } from "@/server/core/client";
import { db } from "@/server/db";
import { RuleError } from "@/server/framework/errors";

/*
 * Staff invitation identity. Before a staff email is added to a business that is linked to Studio
 * (coreBusinessId), Studio is asked to ensure an identity for it, and the returned coreUserId is
 * linked to the existing local user. Base client on purpose (User is outside tenant scope), as in
 * core-handoff.ts. Only the email, the user's display name and the opaque coreUserId travel; nothing
 * is stored for an email that has no local user yet.
 *
 * - Standalone business (no coreBusinessId) or no Studio configured: does nothing at all.
 * - Studio unreachable or malformed: RuleError CORE_UNAVAILABLE (retryable); no silent fallback.
 * - Local user already linked to a different coreUserId, or the coreUserId already belongs to
 *   another local user: RuleError IDENTITY_CONFLICT; nothing is changed.
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
      select: { id: true, name: true, coreUserId: true },
    });
    let identity: { coreUserId: string };
    try {
      identity = await client.ensureIdentity(email, local?.name);
    } catch (e) {
      if (e instanceof CoreClientError) throw new RuleError("CORE_UNAVAILABLE");
      throw e;
    }
    if (!local) continue; // the existing flow reports USER_NOT_FOUND; nothing is remembered here
    if (local.coreUserId === identity.coreUserId) continue;
    if (local.coreUserId !== null) throw new RuleError("IDENTITY_CONFLICT");
    try {
      // Guarded: only an unlinked user is linked.
      const { count } = await db.user.updateMany({ where: { id: local.id, coreUserId: null }, data: { coreUserId: identity.coreUserId } });
      if (count !== 1) throw new RuleError("IDENTITY_CONFLICT");
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new RuleError("IDENTITY_CONFLICT");
      throw e;
    }
  }
}
