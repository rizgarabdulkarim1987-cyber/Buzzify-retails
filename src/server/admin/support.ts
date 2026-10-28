import { z } from "zod";
import { SupportScope } from "@/generated/prisma/client";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { defineAction } from "@/server/framework/action";
import type { Actor } from "@/server/framework/actor";
import { NotFoundError, RuleError, SupportAccessError } from "@/server/framework/errors";
import { gateOf } from "@/server/framework/gate";
import { ScopeError, scopedDb } from "@/server/framework/scoped-db";
import { isPlatformAdmin } from "./platform-admin";

export { SupportAccessError, SupportScope };

/*
 * Time-boxed, audited support access. A platform admin has NO access to a business's data unless
 * its OWNER gave them a grant: named scopes, a reason, at most 72 hours, revocable at once.
 *
 * Reads happen only through runSupportRead: one transaction that resolves the grant, writes the
 * `support.read` audit row FIRST (no audit row, no read), then runs the caller's read with the
 * business-scoped client wrapped read-only. The actor is never the shop user in disguise: it
 * carries `viaSupportGrantId` so the UI can always show "support access".
 *
 * Cost and export: the support actor has role AUDITOR, which the permission matrix gives neither
 * `cost.view` nor `data.export`. Any read helper that returns cost columns must check
 * can(actor.role, "cost.view"), so support never sees cost (no cost columns exist yet).
 */

export type SupportActor = Actor & {
  viaSupportGrantId: string;
  scopes: readonly SupportScope[];
  readOnly: true;
};

/** The dotted form of a scope as the database stores it and the audit log records it. */
export const SCOPE_LABEL: Readonly<Record<SupportScope, string>> = Object.freeze({
  CATALOG_READ: "catalog.read",
  STOCK_READ: "stock.read",
  SALES_READ: "sales.read",
});

type Client = PrismaClient | Prisma.TransactionClient;

// ---------------------------------------------------------------------------------------------
// Grant and revoke (owner actions)

const grantInput = z.object({
  granteeId: z.string().min(1),
  scopes: z.array(z.enum(SupportScope)).min(1),
  reason: z.string().trim().min(10),
  hours: z.number().int().min(1).max(72),
});

/** The owner gives one platform admin read access to named scopes for 1 to 72 hours. */
export const grantSupport = defineAction({
  name: "support.grant",
  permission: "support.grant",
  input: grantInput,
  writes: true,
  async precondition({ input }) {
    // The grantee must be a Buzzify platform admin (a shop user cannot be given support access).
    if (!(await isPlatformAdmin(input.granteeId))) throw new RuleError("INVALID_INPUT");
  },
  async run({ actor, tx, input }) {
    const createdAt = new Date();
    const grant = await tx.rtSupportGrant.create({
      data: {
        businessId: actor.businessId,
        granteeId: input.granteeId,
        scopes: [...new Set(input.scopes)],
        reason: input.reason,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + input.hours * 3_600_000),
        grantedById: actor.userId,
      },
      select: { id: true },
    });
    return { grantId: grant.id };
  },
  audit: (input, value) => ({
    entity: "RtSupportGrant",
    entityId: value.grantId,
    changes: {
      granteeId: input.granteeId,
      scopes: [...new Set(input.scopes)].map((s) => SCOPE_LABEL[s]),
      reason: input.reason,
      hours: input.hours,
    },
  }),
});

/**
 * Ends a grant at once. Revoking again is not an error and does not move revokedAt. Allowed while
 * the business is READ_ONLY (taking access away must never be blocked by billing state).
 */
export const revokeSupport = defineAction({
  name: "support.revoke",
  permission: "support.grant",
  input: z.object({ grantId: z.string().min(1) }),
  writes: true,
  allowWhenReadOnly: true,
  async run({ tx, input }) {
    // The scoped client only sees this business's grants: another business's grant is NOT_FOUND.
    const grant = await tx.rtSupportGrant.findFirst({ where: { id: input.grantId }, select: { id: true } });
    if (!grant) throw new NotFoundError();
    await tx.rtSupportGrant.updateMany({ where: { id: input.grantId, revokedAt: null }, data: { revokedAt: new Date() } });
    return { grantId: grant.id };
  },
  audit: (input) => ({ entity: "RtSupportGrant", entityId: input.grantId, changes: { revoked: true } }),
});

// ---------------------------------------------------------------------------------------------
// Using a grant

async function resolveWith(client: Client, grantId: string, userId: string, now: Date): Promise<SupportActor> {
  if (typeof grantId !== "string" || typeof userId !== "string" || grantId === "" || userId === "") {
    throw new SupportAccessError("NO_GRANT");
  }
  const grant = await client.rtSupportGrant.findUnique({ where: { id: grantId } });
  if (!grant) throw new SupportAccessError("NO_GRANT");
  if (grant.granteeId !== userId) throw new SupportAccessError("NOT_GRANTEE");
  if (grant.revokedAt) throw new SupportAccessError("REVOKED");
  if (grant.expiresAt.getTime() <= now.getTime()) throw new SupportAccessError("EXPIRED");
  if (!(await isPlatformAdmin(userId, client))) throw new SupportAccessError("NOT_PLATFORM_ADMIN");
  // Support only reads, so READ_ONLY is fine; a closed or archived business refuses everything.
  if ((await gateOf(grant.businessId, client, now)) === "CLOSED") throw new SupportAccessError("BUSINESS_CLOSED");
  return Object.freeze({
    userId,
    businessId: grant.businessId,
    role: "AUDITOR" as const,
    branchIds: "ALL" as const,
    viaSupportGrantId: grant.id,
    scopes: Object.freeze([...grant.scopes]),
    readOnly: true as const,
  });
}

/**
 * The read-only actor a platform admin becomes under a live grant. Throws SupportAccessError
 * (FORBIDDEN) when the grant is missing, someone else's, revoked, expired (the exact expiry
 * instant is already refused), or the business is closed/archived. `now` is injectable for tests.
 */
export function resolveSupportActor(grantId: string, userId: string): Promise<SupportActor> {
  // The clock is internal on purpose: a caller must never be able to choose "now" and revive an expired grant.
  return resolveWith(db, grantId, userId, new Date());
}

const READ_OPERATIONS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);

/**
 * Wraps a scoped client so only read operations get through. Everything else (every write, raw
 * SQL, nested transactions) rejects with ScopeError('READ_ONLY_ACTOR'). Allow-list, not deny-list:
 * an operation added by a future Prisma version is refused until listed here.
 */
function readOnly<C extends object>(client: C): C {
  const refuse = (what: string) => () => Promise.reject(new ScopeError("READ_ONLY_ACTOR", what));
  const delegate = (model: object, name: string) =>
    new Proxy(model, {
      get(target, op, receiver) {
        const value: unknown = Reflect.get(target, op, receiver);
        if (typeof op !== "string" || typeof value !== "function") return value;
        if (READ_OPERATIONS.has(op)) return (value as (...a: unknown[]) => unknown).bind(target);
        return refuse(`${name}.${op}`);
      },
    });
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string") return value;
      if (prop.startsWith("$")) return refuse(prop); // $executeRaw, $queryRaw, $transaction, $extends, ...
      if (typeof value === "object" && value !== null) return delegate(value, prop);
      return value;
    },
  });
}

export type SupportReadContext = { actor: SupportActor; db: Prisma.TransactionClient };

/**
 * Runs one support read in two transactions: (1) resolve the actor, refuse a scope the grant does
 * not include, and commit the `support.read` audit row (grant, scope, actor; never the data read);
 * if that fails `read` never runs; (2) re-resolve the grant and run `read` with the business-scoped,
 * read-only client. A read that throws or is refused at step 2 keeps its audit row: the attempt is on
 * record. The clock is internal (never a parameter).
 */
export async function runSupportRead<T>(
  grantId: string,
  userId: string,
  scope: SupportScope,
  read: (ctx: SupportReadContext) => Promise<T>,
): Promise<T> {
  // Transaction 1: resolve the grant and COMMIT the audit row. If this fails the read never runs.
  // The row stays even if the read below fails or the grant is revoked in between.
  await db.$transaction(async (tx) => {
    const actor = await resolveWith(tx, grantId, userId, new Date());
    if (!actor.scopes.includes(scope)) throw new SupportAccessError("SCOPE_NOT_GRANTED");
    await tx.rtAuditLog.create({
      data: {
        businessId: actor.businessId,
        actorId: actor.userId,
        action: "support.read",
        entity: "RtSupportGrant",
        entityId: grantId,
        changes: { grantId, scope: SCOPE_LABEL[scope], actorId: actor.userId, viaSupportGrantId: grantId },
      },
    });
  });
  // Transaction 2: re-resolve (a revoke or expiry since the audit is honoured) and run the read.
  return db.$transaction(
    async (tx) => {
      const actor = await resolveWith(tx, grantId, userId, new Date());
      if (!actor.scopes.includes(scope)) throw new SupportAccessError("SCOPE_NOT_GRANTED");
      return read({ actor, db: readOnly(scopedDb(actor, tx)) });
    },
    { timeout: 30_000, maxWait: 5_000 },
  );
}
