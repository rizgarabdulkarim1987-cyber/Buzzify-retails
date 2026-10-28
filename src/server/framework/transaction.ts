import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { IdempotencyMismatchError } from "./errors";

/*
 * Shared machinery behind defineAction (and Task 7's definePlatformAction): one database
 * transaction that commits the change, its audit row and the idempotency result together, or
 * nothing. Only the framework folder may import the base client, so this is where it is used.
 */

type Tx = Prisma.TransactionClient;

/** JSON round trip: what a value looks like once stored (Dates become strings, undefined disappears). */
export function toJsonValue(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? null : JSON.parse(text);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

/** sha256 of the JSON of `value` with object keys sorted at every level. */
export function payloadHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortKeys(toJsonValue(value))))
    .digest("hex");
}

export type AuditDraft = { entity: string; entityId: string; changes: Record<string, unknown> };

export type WritePlan<O> = {
  /** Idempotency namespace: the businessId, or 'platform'. */
  scope: string;
  key: string;
  payloadHash: string;
  /** Null for platform-level audit rows. */
  auditBusinessId: string | null;
  actorId: string;
  action: string;
  /** Does the change; returns the value and what to audit. Runs inside the transaction. */
  run(tx: Tx): Promise<{ value: O; audit: AuditDraft }>;
};

/** Fixed-alphabet lock name for (scope, key): hashing keeps odd characters out of the SQL parameter. */
function lockName(plan: { scope: string; key: string }): string {
  return createHash("sha256").update(JSON.stringify([plan.scope, plan.key])).digest("hex");
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002"
  );
}

type Stored = { payloadHash: string; result: unknown };

function replay<O>(stored: Stored, hash: string): { value: O; replayed: true } {
  if (stored.payloadHash !== hash) throw new IdempotencyMismatchError();
  return { value: (stored.result as { value: O }).value, replayed: true };
}

/**
 * Runs plan.run once per (scope, key). A repeat with the same payload returns the stored value
 * without running; a repeat with another payload throws IdempotencyMismatchError. Any error from
 * run rolls everything back (the key is not consumed).
 *
 * Concurrency: a transaction-scoped advisory lock on (scope, key) serializes same-key callers, so
 * the second one waits for the first to commit and then replays. The unique constraint is the
 * backstop: if it still fires (P2002 on RtIdempotency), the stored row is re-read.
 */
export async function runIdempotentWrite<O>(
  plan: WritePlan<O>,
  client: PrismaClient = db,
): Promise<{ value: O; replayed: boolean }> {
  const attempt = () =>
    client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockName(plan)}, 0))`;
      const existing = await tx.rtIdempotency.findUnique({
        where: { scope_key: { scope: plan.scope, key: plan.key } },
      });
      if (existing) return replay<O>(existing, plan.payloadHash);

      const { value, audit } = await plan.run(tx);
      await tx.rtAuditLog.create({
        data: {
          businessId: plan.auditBusinessId,
          actorId: plan.actorId,
          action: plan.action,
          entity: audit.entity,
          entityId: audit.entityId,
          changes: toJsonValue(audit.changes) as Prisma.InputJsonObject,
        },
      });
      await tx.rtIdempotency.create({
        data: {
          scope: plan.scope,
          key: plan.key,
          payloadHash: plan.payloadHash,
          result: { value: toJsonValue(value) } as Prisma.InputJsonObject,
        },
      });
      return { value, replayed: false };
    });

  try {
    return await attempt();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const stored = await client.rtIdempotency.findUnique({
      where: { scope_key: { scope: plan.scope, key: plan.key } },
    });
    if (!stored) throw err; // the violation came from the action's own writes
    return replay<O>(stored, plan.payloadHash);
  }
}

/** Runs a read inside a transaction (one consistent snapshot); no audit, no idempotency row. */
export function runRead<O>(work: (tx: Tx) => Promise<O>, client: PrismaClient = db): Promise<O> {
  return client.$transaction(work);
}
