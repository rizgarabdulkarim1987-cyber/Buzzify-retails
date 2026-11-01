import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { ForbiddenError } from "@/server/framework/errors";

/*
 * Buzzify platform administrators (RtPlatformAdmin). Being one allows the platform actions in
 * this folder (provisioning, invitations, lifecycle, feature overrides) and nothing else: a
 * platform admin has NO implicit access to a business's data. Reading or changing a tenant's own
 * records goes through time-limited, authorized support access (Task 8), never through this flag.
 */

type Client = PrismaClient | Prisma.TransactionClient;

export async function isPlatformAdmin(userId: string, client: Client = db): Promise<boolean> {
  if (typeof userId !== "string" || userId === "") return false;
  const row = await client.rtPlatformAdmin.findUnique({ where: { userId }, select: { id: true } });
  return row !== null;
}

/** Throws ForbiddenError (FORBIDDEN in an action result) unless `userId` is a platform admin. */
export async function requirePlatformAdmin(userId: string, client: Client = db): Promise<void> {
  if (!(await isPlatformAdmin(userId, client))) throw new ForbiddenError("NOT_A_PLATFORM_ADMIN");
}
