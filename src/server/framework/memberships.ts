import type { RtActivityType, RtRole } from "@/generated/prisma/client";
import { db } from "@/server/db";

export type Membership = { businessId: string; name: string; role: RtRole; activityType: RtActivityType };

/**
 * The businesses a signed-in user may enter: active staff rows (not deactivated) of businesses
 * that are not ARCHIVED, ordered by business name. Like resolveActor, this runs before any
 * business is chosen, so it reads with the base client and must stay in src/server/framework/.
 * It returns only the user's own memberships and each business's display name and activity type
 * (which product it belongs to, src/packs).
 */
export async function listMemberships(userId: string): Promise<Membership[]> {
  if (typeof userId !== "string" || userId === "") return [];
  const rows = await db.rtStaff.findMany({
    where: { userId, deactivatedAt: null, business: { status: { not: "ARCHIVED" } } },
    select: { role: true, business: { select: { id: true, name: true, activityType: true } } },
    orderBy: [{ business: { name: "asc" } }, { businessId: "asc" }],
    take: 100,
  });
  return rows.map((r) => ({ businessId: r.business.id, name: r.business.name, role: r.role, activityType: r.business.activityType }));
}
