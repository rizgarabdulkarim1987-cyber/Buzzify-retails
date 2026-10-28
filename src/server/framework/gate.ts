import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { gateFor, type GateMode } from "@/server/domain/subscription";

export type { GateMode } from "@/server/domain/subscription";

type Client = PrismaClient | Prisma.TransactionClient;

const LIVE = ["TRIAL", "ACTIVE", "GRACE"] as const;
const subscriptionFields = {
  status: true,
  trialEndsAt: true,
  currentPeriodEnd: true,
  graceDays: true,
  cancelledAt: true,
} as const;

/**
 * What a business may do right now. Reads the business and its subscription with the base client
 * (the framework folder may; tenants never reach these tables). ARCHIVED: CLOSED. SUSPENDED:
 * READ_ONLY. Otherwise the subscription decides: the live one, else the most recent, else none
 * (CLOSED). `now` is injectable for tests.
 */
export async function gateOf(businessId: string, client: Client, now: Date = new Date()): Promise<GateMode> {
  const business = await client.rtBusiness.findUnique({ where: { id: businessId }, select: { status: true } });
  if (!business || business.status === "ARCHIVED") return "CLOSED";
  if (business.status === "SUSPENDED") return "READ_ONLY";

  const orderBy = [{ createdAt: "desc" }, { id: "desc" }] as const;
  const subscription =
    (await client.rtSubscription.findFirst({
      where: { businessId, status: { in: [...LIVE] } },
      orderBy: [...orderBy],
      select: subscriptionFields,
    })) ??
    (await client.rtSubscription.findFirst({ where: { businessId }, orderBy: [...orderBy], select: subscriptionFields }));
  return gateFor(subscription, now);
}
