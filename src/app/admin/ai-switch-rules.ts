import type { Messages } from "@/messages";
import type { ErrorCode } from "@/server/framework/errors";

/*
 * The ai.intake switch on the admin page: what the browser checks before sending (the server
 * checks the same again: overrideFeature's reason is 10 to 500 characters after trimming).
 */

export const AI_REASON_MIN = 10;
export const AI_REASON_MAX = 500;

export type AiReasonProblem = "REASON_SHORT" | "REASON_LONG";

export type AiSwitchFailure = ErrorCode | "INTERNAL";

export type AiSwitchResult = { ok: true; enabled: boolean } | { ok: false; code: AiSwitchFailure };

export function aiReasonProblem(reason: string): AiReasonProblem | null {
  const n = reason.trim().length;
  if (n < AI_REASON_MIN) return "REASON_SHORT";
  if (n > AI_REASON_MAX) return "REASON_LONG";
  return null;
}

/**
 * The idempotency key of one change. The same change sent again (a retry after a lost answer)
 * keeps its key, so the server replays instead of recording it twice; a different change gets a new one.
 */
export function aiAttempt(
  prev: { payload: string; key: string } | null,
  payload: string,
  makeKey: () => string,
): { payload: string; key: string } {
  return prev && prev.payload === payload ? prev : { payload, key: makeKey() };
}

/** The refusal in the UI locale. */
export function aiFailureText(code: AiSwitchFailure, t: Pick<Messages, "errors" | "internalError">): string {
  return code === "INTERNAL" ? t.internalError : t.errors[code];
}
