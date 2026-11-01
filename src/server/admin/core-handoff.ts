import { randomUUID } from "node:crypto";
import { auth } from "@/server/auth/auth";
import { openSession } from "@/server/auth/session-cookie";
import { checkState, nonceMatches, verifyHandoff, type HandoffClaims } from "@/server/core/handoff";
import { db } from "@/server/db";

/*
 * Sign-in through a Studio handoff (GET /api/core/v1/handoff/callback). Platform-level like the
 * rest of this folder: no business is chosen yet, so it runs on the base client. Order:
 *   1. expired RtCoreNonce rows are deleted (every call, whatever happens next);
 *   2. the query state must equal the state cookie (constant time), else nothing is spent;
 *   3. the token is verified (signature, aud, 60 s lifetime) and must be bound to this browser:
 *      its nonce must be base64url(sha256(state)), which /start sent to Studio and Studio echoes
 *      into the token (contract for Studio, see startHandoff); a mismatch spends nothing;
 *   4. its jti is consumed by inserting RtCoreNonce (kept ~2 minutes); a duplicate is a replay;
 *   5. in one transaction: when the token names a business (coreBusinessId present and non-empty):
 *      that business (unknown -> refuse), the local user (see resolveUser), and for Studio's owner
 *      of that business an active RtStaff OWNER row. When it names none (staff without a Studio
 *      business): only the local user, by the same rules; no business lookup, and no RtStaff row
 *      is ever created or changed, so access comes only from existing memberships;
 *   6. a Better Auth session (12 h) for the user.
 * Failures carry a reason for tests and logs; the route never shows it to the browser.
 */

export type HandoffFailure = "STATE" | "TOKEN" | "NONCE" | "REPLAY" | "BUSINESS" | "ACCOUNT_CONFLICT";

export type HandoffOutcome =
  | { ok: true; userId: string; businessId: string | null; returnTo: string; setCookie: string }
  | { ok: false; reason: HandoffFailure };

/** How long a spent jti is remembered; longer than any token can live (60 s + 5 s clock leeway). */
export const NONCE_TTL_MS = 120_000;

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

class Refused extends Error {
  constructor(readonly reason: HandoffFailure) {
    super(reason);
  }
}

export async function completeHandoff(
  input: { token: string | null; state: string | null; stateCookie: string | null; ipAddress?: string; userAgent?: string },
  now: Date = new Date(),
): Promise<HandoffOutcome> {
  await db.rtCoreNonce.deleteMany({ where: { expiresAt: { lt: now } } });

  const matched = checkState(input.stateCookie, input.state);
  if (!matched) return { ok: false, reason: "STATE" };

  const verified = verifyHandoff(input.token ?? "", now);
  if (!verified.ok) return { ok: false, reason: "TOKEN" };
  const claims = verified.claims;
  if (!nonceMatches(claims.nonce, input.state ?? "")) return { ok: false, reason: "NONCE" };

  const { count } = await db.rtCoreNonce.createMany({
    data: [{ jti: claims.jti, expiresAt: new Date(now.getTime() + NONCE_TTL_MS) }],
    skipDuplicates: true,
  });
  if (count !== 1) return { ok: false, reason: "REPLAY" };

  const coreBusinessId = typeof claims.coreBusinessId === "string" && claims.coreBusinessId !== "" ? claims.coreBusinessId : null;

  let linked: { userId: string; businessId: string | null };
  try {
    linked = await db.$transaction(async (tx) => {
      // Serialises concurrent handoffs of one Studio user (the unique columns are the backstop).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`core.handoff:${claims.coreUserId}`}, 0))`;
      if (coreBusinessId === null) {
        return { userId: await resolveUser(tx, claims, null), businessId: null };
      }
      // Row lock first: serialises with applyCoreState (which locks the same row), so the owner
      // compared below is the one the latest committed snapshot set, and a demotion cannot be undone.
      await tx.$executeRaw`SELECT 1 FROM "RtBusiness" WHERE "coreBusinessId" = ${coreBusinessId} FOR UPDATE`;
      const business = await tx.rtBusiness.findUnique({
        where: { coreBusinessId },
        select: { id: true, coreOwnerUserId: true },
      });
      if (!business) throw new Refused("BUSINESS");
      const userId = await resolveUser(tx, claims, business.id);
      if (business.coreOwnerUserId !== null && business.coreOwnerUserId === claims.coreUserId) {
        await ensureOwner(tx, business.id, userId);
      }
      return { userId, businessId: business.id };
    });
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.reason };
    throw err;
  }

  const session = await openSession(linked.userId, { ipAddress: input.ipAddress, userAgent: input.userAgent });
  return { ok: true, ...linked, returnTo: matched.returnTo, setCookie: session.setCookie };
}

/**
 * The local user for this Studio identity, never taking over an account:
 *   - the user already linked to claims.coreUserId (whatever its email now is) — the only way in
 *     for a platform admin;
 *   - otherwise Studio must say the email is verified, else the handoff is refused outright (no
 *     user is created either, so an unverified address cannot be squatted ahead of its owner);
 *   - with a verified email, the local users whose email matches ignoring case: more than one is
 *     refused (ambiguous); exactly one is linked unless it is linked to another Studio user (never
 *     relinked) or is a platform admin (never linked by email);
 *   - none: a new user (lowercased email, no Account row, so no password) linked to coreUserId.
 */
async function resolveUser(tx: Tx, claims: HandoffClaims, businessId: string | null): Promise<string> {
  const byCore = await tx.user.findUnique({ where: { coreUserId: claims.coreUserId }, select: { id: true } });
  if (byCore) return byCore.id;

  if (!claims.emailVerified) throw new Refused("ACCOUNT_CONFLICT");
  const email = claims.email.trim().toLowerCase();
  if (email === "" || email.length > 254) throw new Refused("ACCOUNT_CONFLICT");

  const matches = await tx.user.findMany({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, coreUserId: true, platformAdmin: { select: { userId: true } } },
    take: 2,
  });
  if (matches.length > 1) throw new Refused("ACCOUNT_CONFLICT");

  const existing = matches[0];
  if (existing) {
    if (existing.coreUserId !== null || existing.platformAdmin !== null) throw new Refused("ACCOUNT_CONFLICT");
    await tx.user.update({ where: { id: existing.id }, data: { coreUserId: claims.coreUserId, emailVerified: true } });
    await tx.rtAuditLog.create({
      data: { businessId, actorId: existing.id, action: "core.handoff.link", entity: "User", entityId: existing.id, changes: { by: "verified-email" } },
    });
    return existing.id;
  }

  const ctx = await auth.$context;
  const id = ctx.generateId({ model: "user" }) || randomUUID();
  const name = claims.name.trim().slice(0, 120) || email;
  await tx.user.create({ data: { id, email, name, emailVerified: true, coreUserId: claims.coreUserId } });
  await tx.rtAuditLog.create({
    data: { businessId, actorId: id, action: "core.handoff.link", entity: "User", entityId: id, changes: { by: "created" } },
  });
  return id;
}

/**
 * Studio's owner of the business is its OWNER here: creates the RtStaff row, or makes an existing
 * one OWNER and active again. Studio is the source of truth for ownership, so a deactivated owner
 * row is reactivated by a handoff from the Studio owner. OWNER resolves to all branches, so no
 * RtStaffBranch rows are needed. Nothing is written when the row is already an active OWNER.
 */
async function ensureOwner(tx: Tx, businessId: string, userId: string): Promise<void> {
  const row = await tx.rtStaff.findUnique({
    where: { businessId_userId: { businessId, userId } },
    select: { id: true, role: true, deactivatedAt: true },
  });
  if (row && row.role === "OWNER" && row.deactivatedAt === null) return;

  const staff = row
    ? await tx.rtStaff.update({
        where: { id: row.id },
        data: { role: "OWNER", deactivatedAt: null, version: { increment: 1 } },
        select: { id: true },
      })
    : await tx.rtStaff.create({ data: { businessId, userId, role: "OWNER" }, select: { id: true } });
  await tx.rtAuditLog.create({
    data: {
      businessId,
      actorId: userId,
      action: "core.handoff.owner",
      entity: "RtStaff",
      entityId: staff.id,
      changes: row ? { role: { from: row.role, to: "OWNER" }, reactivated: row.deactivatedAt !== null } : { role: "OWNER", created: true },
    },
  });
}
