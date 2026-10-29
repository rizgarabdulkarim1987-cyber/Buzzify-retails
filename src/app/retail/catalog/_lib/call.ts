import type { ActionMeta } from "@/server/framework/action";
import { IdempotencyMismatchError, InternalActionError, type Result } from "@/server/framework/errors";
import { loadShell } from "../../_shell";
import type { UiResult } from "./types";

/** A refusal made by a wrapper itself (text it could not turn into a value, or no session). */
export const fail = (code: Extract<UiResult<never>, { ok: false }>["code"]): UiResult<never> => ({ ok: false, code });

/** The session user and the business they work in (from the server, never from the browser), with the given idempotency key. */
export async function metaFor(key: unknown): Promise<ActionMeta | null> {
  const shell = await loadShell();
  if (!shell?.businessId) return null;
  return { userId: shell.user.id, businessId: shell.businessId, idempotencyKey: typeof key === "string" ? key : "" };
}

/**
 * Runs an action for the browser: the meta from the session, the result as a typed UiResult (an
 * optional `map` turns the value into what the browser receives), an unexpected failure as INTERNAL.
 */
export async function call<T, V = T>(key: unknown, run: (meta: ActionMeta) => Promise<Result<T>>, map?: (v: T) => V): Promise<UiResult<V>> {
  const meta = await metaFor(key);
  if (!meta) return fail("FORBIDDEN");
  try {
    const r = await run(meta);
    if (!r.ok) return r.details ? { ok: false, code: r.code, details: r.details } : { ok: false, code: r.code };
    return { ok: true, value: map ? map(r.value) : (r.value as unknown as V) };
  } catch (err) {
    if (err instanceof IdempotencyMismatchError) return fail("IDEMPOTENCY_MISMATCH");
    if (err instanceof InternalActionError) return fail("INTERNAL");
    throw err;
  }
}
