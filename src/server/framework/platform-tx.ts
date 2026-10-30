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
 * Only framework files read this (tenant code gets the scoped client and never the base one).
 */

const store = new AsyncLocalStorage<Prisma.TransactionClient>();

/** Runs `fn` with `tx` as the current action's base transaction client. Used by defineAction only. */
export function withPlatformTx<T>(tx: Prisma.TransactionClient, fn: () => T): T {
  return store.run(tx, fn);
}

/** The running action's base transaction client, or undefined outside an action's `run`. */
export function currentPlatformTx(): Prisma.TransactionClient | undefined {
  return store.getStore();
}
