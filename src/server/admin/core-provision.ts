import { createHash } from "node:crypto";
import { z } from "zod";
import { ACTIVITY_TYPES, CAPABILITIES } from "@/server/domain/profiles";
import { applyCoreState, CORE_SYNC_ACTOR, corePlanCode, coreStateSchema, upsertCorePlan } from "@/server/core/state";
import { db } from "@/server/db";
import { provisionInTx, MAX_BRANCHES } from "./provision";

/*
 * Provisioning on Studio's request (POST /api/core/v1/provision). Platform-level like the rest of
 * this folder: the business does not exist yet, so there is no tenant scope, and it runs on the
 * base client in ONE transaction: plan from the snapshot, business + branches + locations +
 * capabilities (provisionInTx, the same code as the platform action), the link to Studio, the first
 * snapshot (applyCoreState) and an audit row. Any failure leaves nothing. No owner invitation: the
 * owner arrives through Studio sign-in.
 *
 * Idempotent on coreBusinessId: a repeat finds the business, applies the snapshot only if it is
 * newer, and answers with the same id. An advisory lock serialises same-id callers; the unique
 * column is the backstop for a lost race.
 */

const unique = <T>(list: readonly T[]) => new Set(list).size === list.length;

export const coreProvisionInput = z
  .object({
    coreBusinessId: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(120),
    activityType: z.enum(ACTIVITY_TYPES).default("MIXED"),
    capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length * 2).default([]),
    branches: z
      .array(z.object({ name: z.string().trim().min(1).max(80) }))
      .min(1)
      .max(MAX_BRANCHES)
      .refine((b) => unique(b.map((x) => x.name)), "branch names must be unique"),
    currencies: z.array(z.enum(["IQD", "USD"])).min(1).max(2).refine(unique, "currencies must be unique"),
    state: coreStateSchema,
  })
  .refine((v) => v.state.coreBusinessId === v.coreBusinessId, { message: "state is for another business", path: ["state"] });

export type CoreProvisionInput = z.infer<typeof coreProvisionInput>;

const lockKey = (coreBusinessId: string) => createHash("sha256").update(`core.provision:${coreBusinessId}`).digest("hex");

export async function provisionFromCore(input: CoreProvisionInput): Promise<{ businessId: string; created: boolean }> {
  const run = () =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(input.coreBusinessId)}, 0))`;

      const existing = await tx.rtBusiness.findUnique({ where: { coreBusinessId: input.coreBusinessId }, select: { id: true } });
      if (existing) {
        await applyCoreState(tx, existing.id, input.state);
        return { businessId: existing.id, created: false };
      }

      // The plan must exist before provisionInTx looks it up; it rolls back with everything else on failure.
      await upsertCorePlan(tx, input.state.plan);
      const { businessId } = await provisionInTx(
        tx,
        {
          name: input.name,
          activityType: input.activityType,
          capabilities: input.capabilities,
          branches: input.branches,
          currencies: input.currencies,
          planCode: corePlanCode(input.state.plan.code),
          trialDays: 1, // placeholder trial row; the snapshot below replaces it
        },
        { actorId: CORE_SYNC_ACTOR },
      );
      await tx.rtBusiness.update({ where: { id: businessId }, data: { coreBusinessId: input.coreBusinessId } });
      await applyCoreState(tx, businessId, input.state);
      await tx.rtAuditLog.create({
        data: {
          businessId,
          actorId: CORE_SYNC_ACTOR,
          action: "core.business.provision",
          entity: "RtBusiness",
          entityId: businessId,
          changes: {
            coreBusinessId: input.coreBusinessId,
            name: input.name,
            branches: input.branches.map((b) => b.name),
            currencies: input.currencies,
            planCode: corePlanCode(input.state.plan.code),
            version: input.state.version,
          },
        },
      });
      return { businessId, created: true };
    });

  try {
    return await run();
  } catch (err) {
    // Lost a race on the unique coreBusinessId despite the lock: the other call won, answer with its business.
    if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002") {
      const winner = await db.rtBusiness.findUnique({ where: { coreBusinessId: input.coreBusinessId }, select: { id: true } });
      if (winner) return { businessId: winner.id, created: false };
    }
    throw err;
  }
}
