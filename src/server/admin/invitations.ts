import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { getPack, packWords } from "@/packs";
import { shopOrigin } from "@/packs/urls";
import { getMailer } from "@/server/email/mailer";
import { ForbiddenError, NotFoundError, RuleError } from "@/server/framework/errors";
import { definePlatformAction } from "@/server/framework/platform-action";
import { defineUserAction } from "@/server/framework/user-action";

/*
 * Owner invitations. Security model:
 * - The token is 32 random bytes (base64url, 43 characters). Only its sha256 (hex) is stored; the
 *   raw token exists in the mail and in the creating action's first response (an idempotent
 *   replay returns token: null). It never reaches the audit log or the idempotency table.
 * - A link is valid 7 days, once, and only while it is the business's newest invitation: creating
 *   or resending one supersedes every older unused invitation (a partial unique index allows one
 *   open invitation per business).
 * - Accepting requires the signed-in user's email to equal the invited email (case-insensitive):
 *   a leaked link alone does not grant ownership.
 * - Every invitation write locks the business row first, so invites, resends and accepts of one
 *   business are serialized.
 */

type Tx = Prisma.TransactionClient;

export const INVITATION_TTL_DAYS = 7;
const DAY_MS = 86_400_000;

/** Trimmed, lowercased email (the form invitations are stored and compared in). */
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export function newInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * The accept link. The token travels in the URL fragment, which browsers never send to a server,
 * so it stays out of access logs and Referer headers; the accept page posts it to acceptInvitation.
 */
export function invitationLink(token: string, activityType?: string | null): string {
  // The shop's own product address when PACK_HOSTS has one (src/packs/urls.ts), else APP_URL.
  const base = activityType === undefined ? process.env.APP_URL?.trim().replace(/\/+$/, "") : shopOrigin(activityType);
  if (!base) throw new Error("APP_URL is required to build invitation links");
  return `${base}/invite#token=${token}`;
}

async function lockBusiness(tx: Tx, businessId: string) {
  // Row lock: serializes every invitation write (invite, resend, accept) of this business.
  await tx.$executeRaw`SELECT 1 FROM "RtBusiness" WHERE "id" = ${businessId} FOR UPDATE`;
  return tx.rtBusiness.findUnique({ where: { id: businessId }, select: { id: true, name: true, status: true, coreBusinessId: true, activityType: true } });
}

async function hasActiveOwner(tx: Tx, businessId: string): Promise<boolean> {
  const owner = await tx.rtStaff.findFirst({
    where: { businessId, role: "OWNER", deactivatedAt: null },
    select: { id: true },
  });
  return owner !== null;
}

export type CreatedInvitation = { invitationId: string; token: string | null };

/**
 * Creates the business's new owner invitation (superseding older unused ones) and mails it.
 * Runs inside the caller's transaction; the mail is sent last, so a mail failure rolls back the
 * whole action. (If the commit itself failed after sending, the mailed token would match no row.)
 */
export async function createOwnerInvitation(
  tx: Tx,
  args: { businessId: string; email: string; createdById: string; now?: Date },
): Promise<{ invitationId: string; token: string; superseded: number; expiresAt: Date }> {
  const now = args.now ?? new Date();
  const business = await lockBusiness(tx, args.businessId);
  if (!business) throw new NotFoundError();
  if (business.status === "ARCHIVED") throw new RuleError("BUSINESS_ARCHIVED");
  // A Studio-linked business has its owner from Studio (sign-in handoff); a local invitation would bypass that.
  if (business.coreBusinessId !== null) throw new RuleError("CORE_MANAGED");
  if (await hasActiveOwner(tx, business.id)) throw new RuleError("OWNER_EXISTS");

  const { count: superseded } = await tx.rtInvitation.updateMany({
    where: { businessId: business.id, usedAt: null, supersededAt: null },
    data: { supersededAt: now },
  });
  const token = newInvitationToken();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_DAYS * DAY_MS);
  const row = await tx.rtInvitation.create({
    data: {
      businessId: business.id,
      email: args.email,
      tokenHash: hashInvitationToken(token),
      expiresAt,
      createdById: args.createdById,
    },
    select: { id: true },
  });

  // The shop's own product name ("Buzzify سوبرماركت"), the same one its address and sign-in page show.
  const product = packWords(getPack(business.activityType), "ar").productName;
  await getMailer().send({
    to: args.email,
    subject: `دعوة لإدارة منشأتك على ${product}`,
    text: [
      "مرحباً،",
      "",
      `تمت دعوتك لتكون مالك المنشأة "${business.name}" على ${product}.`,
      `لقبول الدعوة افتح الرابط التالي وسجّل الدخول بهذا البريد الإلكتروني. الرابط صالح لمدة ${INVITATION_TTL_DAYS} أيام ولمرة واحدة فقط:`,
      "",
      invitationLink(token, business.activityType),
      "",
      "إذا لم تكن تتوقع هذه الرسالة فيمكنك تجاهلها.",
    ].join("\n"),
  });

  return { invitationId: row.id, token, superseded, expiresAt };
}

const redactToken = <T extends { token: string | null }>(v: T): T => ({ ...v, token: null });

type InvitationResult = CreatedInvitation & { businessId: string; email: string; superseded: number; expiresAt: Date };

function invitationAudit(kind: string, v: InvitationResult) {
  return {
    businessId: v.businessId,
    entity: "RtInvitation",
    entityId: v.invitationId,
    changes: { kind, email: v.email, expiresAt: v.expiresAt, superseded: v.superseded },
  };
}

/** Platform admin: invite the owner of a business (supersedes older unused invitations). */
export const inviteOwner = definePlatformAction({
  name: "platform.invitation.create",
  input: z.object({ businessId: z.string().min(1).max(64), email: emailSchema }),
  writes: true,
  async run({ adminId, tx, input }): Promise<InvitationResult> {
    const created = await createOwnerInvitation(tx, { businessId: input.businessId, email: input.email, createdById: adminId });
    return { ...created, businessId: input.businessId, email: input.email };
  },
  audit: (_input, v) => invitationAudit("invite", v),
  storedValue: redactToken,
});

/** Platform admin: send a fresh link for an invitation's business and email; older links stop working. */
export const resendInvitation = definePlatformAction({
  name: "platform.invitation.resend",
  input: z.object({ invitationId: z.string().min(1).max(64) }),
  writes: true,
  async run({ adminId, tx, input }): Promise<InvitationResult> {
    const previous = await tx.rtInvitation.findUnique({
      where: { id: input.invitationId },
      select: { businessId: true, email: true },
    });
    if (!previous) throw new NotFoundError();
    const created = await createOwnerInvitation(tx, { ...previous, createdById: adminId });
    return { ...created, businessId: previous.businessId, email: previous.email };
  },
  audit: (_input, v) => invitationAudit("resend", v),
  storedValue: redactToken,
});

/**
 * The invited user accepts: creates their RtStaff OWNER row (OWNER resolves to all branches, so no
 * RtStaffBranch rows), marks the invitation used and moves the business SETUP -> ACTIVE, in one
 * transaction with the audit row. Runs as a user action: the user is not staff of the business yet.
 */
export const acceptInvitation = defineUserAction({
  name: "invitation.accept",
  input: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
  async run({ userId, tx, input }) {
    const now = new Date();
    const tokenHash = hashInvitationToken(input.token);
    const found = await tx.rtInvitation.findUnique({ where: { tokenHash }, select: { businessId: true } });
    if (!found) throw new RuleError("INVITATION_INVALID");

    const business = await lockBusiness(tx, found.businessId);
    // Re-read after the lock: a concurrent accept or resend has committed by now.
    const inv = await tx.rtInvitation.findUnique({ where: { tokenHash } });
    if (!business || !inv) throw new RuleError("INVITATION_INVALID");

    const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user || user.email.trim().toLowerCase() !== inv.email) throw new ForbiddenError("INVITEE_EMAIL_MISMATCH");

    if (inv.usedAt !== null || inv.supersededAt !== null) throw new RuleError("INVITATION_INVALID");
    if (inv.expiresAt.getTime() <= now.getTime()) throw new RuleError("INVITATION_EXPIRED");
    if (business.status === "ARCHIVED") throw new RuleError("BUSINESS_ARCHIVED");

    const member = await tx.rtStaff.findUnique({
      where: { businessId_userId: { businessId: business.id, userId } },
      select: { id: true },
    });
    if (member) throw new RuleError("ALREADY_MEMBER");
    if (await hasActiveOwner(tx, business.id)) throw new RuleError("OWNER_EXISTS");

    // Guarded update: exactly one accept can flip usedAt.
    const { count } = await tx.rtInvitation.updateMany({
      where: { id: inv.id, usedAt: null, supersededAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (count !== 1) throw new RuleError("INVITATION_INVALID");

    const staff = await tx.rtStaff.create({
      data: { businessId: business.id, userId, role: "OWNER" },
      select: { id: true },
    });
    let activated = false;
    if (business.status === "SETUP") {
      const moved = await tx.rtBusiness.updateMany({
        where: { id: business.id, status: "SETUP" },
        data: { status: "ACTIVE", version: { increment: 1 } },
      });
      activated = moved.count === 1;
    }
    return { businessId: business.id, staffId: staff.id, invitationId: inv.id, activated };
  },
  audit: (_input, v) => ({
    businessId: v.businessId,
    entity: "RtInvitation",
    entityId: v.invitationId,
    changes: { staffId: v.staffId, role: "OWNER", activated: v.activated },
  }),
});
