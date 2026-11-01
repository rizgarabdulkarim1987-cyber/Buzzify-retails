import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@/generated/prisma/client";

/*
 * The base (unscoped) transaction client of the action that is running, for the framework's own
 * platform reads (the plan, the feature switches) made from inside an action's `run`.
 *
 * Why: such a read on the base `db` needs a second pool connection while the action's transaction
 * already holds one. Under a burst of concurrent actions every pooled connection can be held by a
 * transaction waiting for another connection, and they all stall until the transaction timeout.
 * Reading on the running transaction's own connection avoids that.
 *
 * Guards:
 * - Only src/server/framework/ may import this module (tests/enforcement/no-direct-db.test.ts).
 *   Tenant code gets the scoped client and never the base one.
 * - The context is bound to the action's business: a read for another business gets undefined
 *   (the caller falls back to `db`) instead of the wrong transaction.
 * - The context closes when the wrapped run settles: a continuation that fires after commit or
 *   rollback gets undefined and falls back to `db` instead of a finished transaction.
 */

type Holder = { tx: Prisma.TransactionClient; businessId: string; open: boolean };

const store = new AsyncLocalStorage<Holder>();

/** Runs `fn` with `tx` as the current action's base transaction client for `businessId`. Used by defineAction only. */
export async function withPlatformTx<T>(tx: Prisma.TransactionClient, businessId: string, fn: () => Promise<T>): Promise<T> {
  const holder: Holder = { tx, businessId, open: true };
  try {
    return await store.run(holder, fn);
  } finally {
    holder.open = false;
  }
}

/**
 * The running action's base transaction client when it belongs to `businessId` and is still open;
 * undefined otherwise (outside a run, another business, or after the run settled).
 */
export function currentPlatformTx(businessId: string): Prisma.TransactionClient | undefined {
  const holder = store.getStore();
  return holder && holder.open && holder.businessId === businessId ? holder.tx : undefined;
}
