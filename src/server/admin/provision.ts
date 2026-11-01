import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { CAPABILITIES, ACTIVITY_TYPES, defaultCapabilities, validateCapabilities, type Capability } from "@/server/domain/profiles";
import { RuleError } from "@/server/framework/errors";
import { definePlatformAction } from "@/server/framework/platform-action";
import { createOwnerInvitation, emailSchema } from "./invitations";

/*
 * Provisioning a new business (platform admin only). One transaction writes the business
 * (SETUP), its branches, one default sellable location per branch, a TRIAL subscription, the
 * enabled capabilities, the owner invitation (and its mail), and the audit row; any failure
 * leaves nothing. The idempotency key makes a double submit create exactly one business.
 */

export const MAX_BRANCHES = 20;
export const DEFAULT_LOCATION_NAME = "المخزن الرئيسي";
const DAY_MS = 86_400_000;

const unique = <T>(list: readonly T[]) => new Set(list).size === list.length;

const provisionInput = z.object({
  name: z.string().trim().min(1).max(120),
  activityType: z.enum(ACTIVITY_TYPES),
  capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length * 2),
  branches: z
    .array(z.object({ name: z.string().trim().min(1).max(80) }))
    .min(1)
    .max(MAX_BRANCHES)
    .refine((b) => unique(b.map((x) => x.name)), "branch names must be unique"),
  ownerEmail: emailSchema,
  // The first currency is the business's default currency.
  currencies: z.array(z.enum(["IQD", "USD"])).min(1).max(2).refine(unique, "currencies must be unique"),
  planCode: z.string().trim().min(1).max(64),
  trialDays: z.number().int().min(1).max(90),
});

export type ProvisionInput = z.infer<typeof provisionInput>;

/** The activity type's defaults plus the requested capabilities, without duplicates. */
export function provisionedCapabilities(input: Pick<ProvisionInput, "activityType" | "capabilities">): Capability[] {
  return [...new Set([...defaultCapabilities(input.activityType), ...input.capabilities])];
}

/** What provisioning needs without the owner: the platform action adds the invitation, the core route adds none. */
export type ProvisionCoreInput = Omit<ProvisionInput, "ownerEmail">;

/**
 * Writes the business (SETUP), branches, default locations, TRIAL subscription (with its event) and
 * capabilities on `tx`. The caller owns the transaction and whatever must follow it (owner
 * invitation, audit row). `actorId` is recorded on the subscription event.
 */
export async function provisionInTx(
  tx: Prisma.TransactionClient,
  input: ProvisionCoreInput,
  ctx: { actorId: string; now?: Date },
): Promise<{ businessId: string }> {
  const now = ctx.now ?? new Date();

  const plan = await tx.rtPlan.findUnique({ where: { code: input.planCode } });
  if (!plan || !plan.active) throw new RuleError("PLAN_UNAVAILABLE");
  if (input.branches.length > plan.maxBranches) throw new RuleError("PLAN_LIMIT");

  const capabilities = provisionedCapabilities(input);
  if (!validateCapabilities(capabilities).ok) throw new RuleError("CAPABILITY_CONFLICT");

  const business = await tx.rtBusiness.create({
    data: {
      name: input.name,
      activityType: input.activityType,
      status: "SETUP",
      timezone: "Asia/Baghdad",
      enabledCurrencies: input.currencies,
      defaultCurrency: input.currencies[0]!,
    },
    select: { id: true },
  });
  const businessId = business.id;

  for (const branch of input.branches) {
    const row = await tx.rtBranch.create({ data: { businessId, name: branch.name }, select: { id: true } });
    await tx.rtLocation.create({
      data: { businessId, branchId: row.id, name: DEFAULT_LOCATION_NAME, sellable: true, central: false },
    });
  }

  const trialEndsAt = new Date(now.getTime() + input.trialDays * DAY_MS);
  const subscription = await tx.rtSubscription.create({
    data: {
      businessId,
      planCode: plan.code,
      status: "TRIAL",
      trialEndsAt,
      currentPeriodStart: now,
      currentPeriodEnd: trialEndsAt,
    },
    select: { id: true },
  });
  await tx.rtSubscriptionEvent.create({
    data: {
      subscriptionId: subscription.id,
      businessId,
      type: "trial.started",
      fromStatus: null,
      toStatus: "TRIAL",
      actorId: ctx.actorId,
      data: { planCode: plan.code, trialDays: input.trialDays },
    },
  });

  await tx.rtCapability.createMany({ data: capabilities.map((capability) => ({ businessId, capability })) });
  return { businessId };
}

export const provisionBusiness = definePlatformAction({
  name: "platform.business.provision",
  input: provisionInput,
  writes: true,
  async run({ adminId, tx, input }) {
    const now = new Date();
    const { businessId } = await provisionInTx(tx, input, { actorId: adminId, now });

    // Last: the invitation sends the mail, so every row above already exists when it goes out.
    const invitation = await createOwnerInvitation(tx, { businessId, email: input.ownerEmail, createdById: adminId, now });

    return { businessId, invitationId: invitation.invitationId, token: invitation.token as string | null };
  },
  audit: (input, v) => ({
    businessId: v.businessId,
    entity: "RtBusiness",
    entityId: v.businessId,
    changes: {
      name: input.name,
      activityType: input.activityType,
      capabilities: provisionedCapabilities(input),
      branches: input.branches.map((b) => b.name),
      currencies: input.currencies,
      planCode: input.planCode,
      trialDays: input.trialDays,
      ownerEmail: input.ownerEmail,
      invitationId: v.invitationId,
    },
  }),
  // The raw token is returned once; the idempotency row keeps the result without it.
  storedValue: (v) => ({ ...v, token: null }),
});
