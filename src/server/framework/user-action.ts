import type { ZodType } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { prepareInput, toFailure } from "./action";
import { ForbiddenError, failure, type Result } from "./errors";
import { canonicalHash } from "./serialize";
import { runIdempotentWrite, type AuditDraft } from "./transaction";

/*
 * User actions: writes by a signed-in user who is not (yet) staff of the business concerned, so
 * defineAction's actor resolution cannot apply. Today the only one is acceptInvitation, where a
 * user becomes a business's OWNER. The action itself must establish the user's right to the
 * business (for an invitation: the token and the invited email) before writing anything.
 *
 * Same machinery as defineAction: one transaction with the change, its audit row and the
 * idempotency result. The idempotency scope is the user ('user:<userId>'), and the key is bound
 * to the action, the user and the input. `audit` is mandatory so secrets in the input (a token)
 * never fall into the default audit of the whole input.
 */

export type UserMeta = { userId: string; idempotencyKey: string };

export type UserAudit = AuditDraft & { businessId: string | null };

export type UserActionSpec<I, O> = {
  name: string;
  input: ZodType<I>;
  /** `tx` is the BASE transaction client: the action must check every row it touches. */
  run(ctx: { userId: string; tx: Prisma.TransactionClient; input: I }): Promise<O>;
  audit(input: I, value: O): UserAudit;
};

export function userScope(userId: string): string {
  return `user:${userId}`;
}

/** Order: input and key (INVALID_INPUT), the user exists (FORBIDDEN), then the transaction. */
export function defineUserAction<I, O>(spec: UserActionSpec<I, O>) {
  return async function userAction(raw: unknown, meta: UserMeta): Promise<Result<O>> {
    const prepared = prepareInput(spec.input, raw, true, meta?.idempotencyKey);
    if (!prepared) return failure("INVALID_INPUT");
    const { input } = prepared;

    try {
      const userId = meta.userId;
      const user =
        typeof userId === "string" && userId !== ""
          ? await db.user.findUnique({ where: { id: userId }, select: { id: true } })
          : null;
      if (!user) throw new ForbiddenError("UNKNOWN_USER");

      const { value } = await runIdempotentWrite<O>({
        scope: userScope(userId),
        key: meta.idempotencyKey,
        payloadHash: canonicalHash({ action: spec.name, actorId: userId, input }),
        auditBusinessId: null,
        actorId: userId,
        action: spec.name,
        async run(tx) {
          const result = await spec.run({ userId, tx, input });
          const { businessId, ...audit } = spec.audit(input, result);
          return { value: result, audit, auditBusinessId: businessId };
        },
      });
      return { ok: true, value };
    } catch (err) {
      return toFailure(spec.name, err);
    }
  };
}
