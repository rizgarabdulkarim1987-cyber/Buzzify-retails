import type { RtRole } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { can } from "@/server/domain/permissions";

export type Actor = {
  userId: string;
  businessId: string;
  role: RtRole;
  branchIds: string[] | "ALL";
};

export type ActorErrorCode = "NOT_A_MEMBER" | "DEACTIVATED";

export class ActorError extends Error {
  override readonly name = "ActorError";
  constructor(readonly code: ActorErrorCode) {
    super(code);
  }
}

/**
 * Resolves who is acting inside a business. This is the one place that reads with the
 * base client before scoping exists; it must stay in src/server/framework/.
 */
export async function resolveActor(userId: string, businessId: string): Promise<Actor> {
  const staff = await db.rtStaff.findUnique({
    where: { businessId_userId: { businessId, userId } },
    include: { branches: { where: { branch: { active: true } }, select: { branchId: true } } },
  });
  if (!staff) throw new ActorError("NOT_A_MEMBER");
  if (staff.deactivatedAt) throw new ActorError("DEACTIVATED");
  return {
    userId,
    businessId,
    role: staff.role,
    branchIds: can(staff.role, "multiBranch.access") ? "ALL" : staff.branches.map((b) => b.branchId),
  };
}
