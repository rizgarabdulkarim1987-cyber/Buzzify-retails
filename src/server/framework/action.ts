import type { ZodType } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { can, type Permission } from "@/server/domain/permissions";
import { ActorError, resolveActor, type Actor } from "./actor";
import {
  ForbiddenError,
  IdempotencyMismatchError,
  InternalActionError,
  NotFoundError,
  RuleError,
  SupportAccessError,
  VersionConflictError,
  failure,
  type ErrorCode,
  type Result,
} from "./errors";
import { gateOf } from "./gate";
import { SerializationError, canonicalHash } from "./serialize";
import { runIdempotentWrite, runRead, type AuditDraft } from "./transaction";
import { scopedDb } from "./scoped-db";

export type { ErrorCode, Result } from "./errors";

export type ActionMeta = { userId: string; businessId: string; idempotencyKey: string };

export type ActionSpec<I, O> = {
  /** Audit action name, e.g. "branch.rename". */
  name: string;
  /** null: any active member of the business may call it. */
  permission: Permission | null;
  input: ZodType<I>;
  /**
   * true: runs in a transaction with an audit row and an idempotency record (a key is required),
   * and is refused unless the business gate is FULL.
   * false: a read; no key, no audit, no idempotency row; refused only when the gate is CLOSED.
   */
  writes: boolean;
  /**
   * true: a write that is still allowed while the business is READ_ONLY (never when CLOSED).
   * Only for actions that reduce exposure, such as revoking support access.
   */
  allowWhenReadOnly?: boolean;
  /**
   * Checks that need the base client (e.g. "is this user a platform admin"), run after the
   * permission and gate checks and before the transaction. Throw RuleError("INVALID_INPUT") to refuse.
   */
  precondition?(ctx: { actor: Actor; input: I }): Promise<void>;
  /**
   * `tx` is the business/branch scoped client of the running transaction.
   * `lockBusiness(name)` takes a transaction-scoped advisory lock on (this business, name), released
   * at commit or rollback. Call it first when the run does check-then-write on shared state (a tree,
   * a uniqueness rule): callers with the same name queue up, and under READ COMMITTED each later
   * statement then sees what the earlier caller committed.
   */
  run(ctx: { actor: Actor; tx: Prisma.TransactionClient; input: I; lockBusiness: (name: string) => Promise<void> }): Promise<O>;
  /** What to record in the audit row. Default: the action name as entity and the input as changes. */
  audit?(input: I, value: O): AuditDraft;
};

/** Advisory lock keyed on (businessId, name) on the base transaction client (the scoped one refuses raw SQL). */
function businessLocker(businessId: string, tx: Prisma.TransactionClient) {
  return async (name: string): Promise<void> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`business-lock:${businessId}:${name}`}, 0))`;
  };
}

/** Maps the typed errors the framework understands to a result code; undefined for anything else. */
function codeOf(err: unknown): ErrorCode | undefined {
  if (err instanceof ActorError) return "FORBIDDEN";
  if (err instanceof VersionConflictError) return "VERSION_CONFLICT";
  if (err instanceof NotFoundError) return "NOT_FOUND";
  if (err instanceof IdempotencyMismatchError) return "IDEMPOTENCY_MISMATCH";
  if (err instanceof RuleError) return err.code;
  if (err instanceof ForbiddenError) return "FORBIDDEN";
  if (err instanceof SupportAccessError) return "FORBIDDEN";
  return undefined;
}

/**
 * Turns an error into a Result. Unknown errors (bugs, database failures, scope violations) are
 * logged server-side and rethrown as InternalActionError, whose message is generic Arabic: the
 * caller (route/UI layer) shows that message and must not expose `cause`. The transaction has
 * already rolled back by then.
 */
export function toFailure(action: string, err: unknown): { ok: false; code: ErrorCode; message: string } {
  const code = codeOf(err);
  if (code) return failure(code);
  console.error(`[action ${action}] unexpected failure`, err);
  throw new InternalActionError(err);
}

/** A usable idempotency key: 1 to 200 characters, no NUL (which Postgres text cannot hold). */
export function validKey(key: unknown): key is string {
  return typeof key === "string" && key.length >= 1 && key.length <= 200 && !key.includes(String.fromCharCode(0));
}

/**
 * The checks every action kind runs before touching the database: the input parses, can be
 * hashed and stored, and a write carries a usable idempotency key. Null means INVALID_INPUT.
 */
export function prepareInput<I>(schema: ZodType<I>, raw: unknown, writes: boolean, key: unknown): { input: I } | null {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return null;
  try {
    canonicalHash(parsed.data); // rejects values that cannot be stored or hashed (NaN, Map, Set, ...)
  } catch (err) {
    if (err instanceof SerializationError) return null;
    throw err;
  }
  if (writes && !validKey(key)) return null;
  return { input: parsed.data };
}

/**
 * Defines a business action. Order of checks: input validation and key presence (INVALID_INPUT),
 * actor resolution (FORBIDDEN for non-members and deactivated staff), permission (FORBIDDEN),
 * business gate (READ_ONLY), then the transaction: idempotency lookup, run, audit row, stored result.
 */
export function defineAction<I, O>(spec: ActionSpec<I, O>) {
  return async function action(raw: unknown, meta: ActionMeta): Promise<Result<O>> {
    const prepared = prepareInput(spec.input, raw, spec.writes, meta.idempotencyKey);
    if (!prepared) return failure("INVALID_INPUT");
    const { input } = prepared;

    try {
      const actor = await resolveActor(meta.userId, meta.businessId);
      if (spec.permission !== null && !can(actor.role, spec.permission)) return failure("FORBIDDEN");

      const mode = await gateOf(meta.businessId, db);
      if (mode === "CLOSED" || (spec.writes && mode !== "FULL" && !(spec.allowWhenReadOnly && mode === "READ_ONLY"))) {
        return failure("READ_ONLY");
      }
      // Runs before the idempotent replay lookup, so a replay of an old success is also re-checked.
      await spec.precondition?.({ actor, input });

      if (!spec.writes) {
        const value = await runRead((tx) => spec.run({ actor, tx: scopedDb(actor, tx), input, lockBusiness: businessLocker(actor.businessId, tx) }));
        return { ok: true, value };
      }

      const { value } = await runIdempotentWrite<O>({
        scope: meta.businessId,
        key: meta.idempotencyKey,
        payloadHash: canonicalHash({ action: spec.name, actorId: actor.userId, input }),
        auditBusinessId: meta.businessId,
        actorId: actor.userId,
        action: spec.name,
        async run(tx) {
          const result = await spec.run({ actor, tx: scopedDb(actor, tx), input, lockBusiness: businessLocker(actor.businessId, tx) });
          const audit = spec.audit?.(input, result) ?? {
            entity: spec.name,
            entityId: "",
            changes: { input },
          };
          return { value: result, audit };
        },
      });
      return { ok: true, value };
    } catch (err) {
      return toFailure(spec.name, err);
    }
  };
}
