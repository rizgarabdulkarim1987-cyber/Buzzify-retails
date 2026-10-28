import type { ZodType } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { requirePlatformAdmin } from "@/server/admin/platform-admin";
import { prepareInput, toFailure } from "./action";
import { failure, type Result } from "./errors";
import { canonicalHash } from "./serialize";
import { runIdempotentWrite, runRead, type AuditDraft } from "./transaction";

/*
 * Platform actions: the one place where work happens outside a business actor. They are run by
 * a Buzzify platform admin (RtPlatformAdmin) to provision businesses, send owner invitations,
 * change a business's lifecycle status and override features. There is no business actor, no
 * business gate and no scoped client: `run` gets the base transaction client.
 *
 * A platform admin has NO implicit access to a business's data. These actions touch only the
 * platform-level records they exist for; reading or changing a tenant's own records is support
 * access (Task 8), time-limited and authorized by the business, never this path.
 *
 * Same machinery as defineAction: one transaction commits the change, its audit row and the
 * idempotency result (scope 'platform'; the key is bound to the action, the admin and the input).
 */

export type PlatformMeta = { userId: string; idempotencyKey: string };

export type PlatformAudit = AuditDraft & {
  /** The business the action acted on, when it has one (null or omitted: a platform-only row). */
  businessId?: string | null;
};

export type PlatformActionSpec<I, O> = {
  /** Audit action name, e.g. "platform.business.provision". */
  name: string;
  input: ZodType<I>;
  /** true: transaction + audit + idempotency (a key is required). false: a read. */
  writes: boolean;
  /** `tx` is the BASE transaction client (unscoped). Touch only platform-level records. */
  run(ctx: { adminId: string; tx: Prisma.TransactionClient; input: I }): Promise<O>;
  /** What to audit. Default: the action name as entity and the input as changes, no business. */
  audit?(input: I, value: O): PlatformAudit;
  /** Redacts one-time secrets before the value is stored for idempotent replay (see WritePlan). */
  storedValue?(value: O): O;
};

/** Platform idempotency namespace (RtIdempotency.scope). */
export const PLATFORM_SCOPE = "platform";

/**
 * Order of checks: input validation and key presence (INVALID_INPUT), platform admin
 * (FORBIDDEN, nothing written), then the transaction: idempotency lookup, run, audit, stored result.
 */
export function definePlatformAction<I, O>(spec: PlatformActionSpec<I, O>) {
  return async function platformAction(raw: unknown, meta: PlatformMeta): Promise<Result<O>> {
    const prepared = prepareInput(spec.input, raw, spec.writes, meta?.idempotencyKey);
    if (!prepared) return failure("INVALID_INPUT");
    const { input } = prepared;

    try {
      await requirePlatformAdmin(meta.userId);
      const adminId = meta.userId;

      if (!spec.writes) {
        const value = await runRead((tx) => spec.run({ adminId, tx, input }));
        return { ok: true, value };
      }

      const { value } = await runIdempotentWrite<O>({
        scope: PLATFORM_SCOPE,
        key: meta.idempotencyKey,
        payloadHash: canonicalHash({ action: spec.name, actorId: adminId, input }),
        auditBusinessId: null,
        actorId: adminId,
        action: spec.name,
        storedValue: spec.storedValue,
        async run(tx) {
          const result = await spec.run({ adminId, tx, input });
          const { businessId, ...audit } = spec.audit?.(input, result) ?? {
            entity: spec.name,
            entityId: "",
            changes: { input },
          };
          return { value: result, audit, auditBusinessId: businessId ?? null };
        },
      });
      return { ok: true, value };
    } catch (err) {
      return toFailure(spec.name, err);
    }
  };
}
