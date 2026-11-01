"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Messages } from "@/messages";
import { fill } from "../_lib/format";
import { Notice } from "../_ui/state";
import { newKey } from "../retail/catalog/_lib/keys";
import { setAiIntake } from "./actions";
import { aiAttempt, aiFailureText, aiReasonProblem, type AiReasonProblem } from "./ai-switch-rules";
import { AiReasonForm, AiStateBadge } from "./ai-switch-views";

type Props = {
  businessId: string;
  businessName: string;
  /** The current state as the page read it (the latest ai.intake override; none: off). */
  enabled: boolean;
  t: Pick<Messages, "adminAi" | "adminCore" | "errors" | "internalError">;
  /** Linked to Studio: the switch is shown but cannot be changed here (Studio overwrites it). */
  coreLinked?: boolean;
  /** The row's other cells (rendered by the page); the switch is the last cell. */
  children?: ReactNode;
  /** How many columns the table has (the reason form spans them in a row of its own). */
  columns: number;
};

/**
 * One business's row of the admin table with its ai.intake master switch as the last cell: the
 * current state, and a button that asks for a reason (in a full-width row under it) before moving
 * it the other way. One change at a time; the key is kept while the same change is retried after
 * a lost answer. Focus goes to the reason when the form opens and back to the button when it
 * closes (never to the page).
 */
export function AiSwitchRow({ businessId, businessName, enabled, t, children, columns, coreLinked = false }: Props) {
  const a = t.adminAi;
  const formId = `ai-${businessId}`;
  /** The state the open form moves to (fixed when it opens), or null while closed. */
  const [next, setNext] = useState<boolean | null>(null);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<AiReasonProblem | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [focusRun, setFocusRun] = useState<{ target: "toggle" | "reason"; n: number } | null>(null);
  const busy = useRef(false);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!focusRun) return;
    (focusRun.target === "reason" ? reasonRef.current : toggleRef.current)?.focus();
  }, [focusRun]);

  const focus = (target: "toggle" | "reason") => setFocusRun((f) => ({ target, n: (f?.n ?? 0) + 1 }));

  const open = () => {
    if (busy.current || coreLinked) return;
    if (next !== null) {
      close();
      return;
    }
    setNext(!enabled);
    setReason("");
    setProblem(null);
    setFailure(null);
    setDone(null);
    focus("reason");
  };

  const close = () => {
    if (busy.current) return;
    setNext(null);
    setProblem(null);
    setFailure(null);
    focus("toggle");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current || next === null) return;
    const found = aiReasonProblem(reason);
    setProblem(found);
    setFailure(null);
    if (found) {
      focus("reason");
      return;
    }
    const current = aiAttempt(attempt.current, `${businessId}:${next}:${reason.trim()}`, newKey);
    attempt.current = current;
    busy.current = true;
    setSending(true);
    try {
      const r = await setAiIntake({ businessId, enabled: next, reason: reason.trim(), key: current.key });
      attempt.current = null; // answered: a later change is a new one
      if (r.ok) {
        setNext(null);
        setReason("");
        setDone(r.enabled ? a.doneOn : a.doneOff);
        focus("toggle");
      } else {
        setFailure(aiFailureText(r.code, t));
      }
    } catch {
      // No answer (network): the key is kept, so sending the same change again records it once.
      setFailure(t.internalError);
    } finally {
      busy.current = false;
      setSending(false);
    }
  };

  return (
    <>
      <tr>
        {children}
        <td className="ai-cell">
          <div className="ai-switch" data-testid="ai-switch">
            <div className="ai-switch-row">
              <AiStateBadge enabled={enabled} t={t} />
              <button
                ref={toggleRef}
                type="button"
                className="btn btn-secondary btn-small"
                onClick={open}
                aria-expanded={next !== null}
                aria-controls={next !== null ? formId : undefined}
                aria-label={fill(enabled ? a.disableFor : a.enableFor, { name: businessName })}
                aria-disabled={sending || coreLinked || undefined}
                aria-describedby={coreLinked ? `${formId}-core` : undefined}
                data-testid="ai-switch-toggle"
              >
                {enabled ? a.disable : a.enable}
              </button>
            </div>
            {coreLinked ? (
              <p id={`${formId}-core`} className="hint" data-testid="core-linked-notice">
                {t.adminCore.locked} {t.adminCore.notice}
              </p>
            ) : null}
            {done && next === null ? <Notice tone="success">{done}</Notice> : null}
          </div>
        </td>
      </tr>
      {next !== null ? (
        <tr className="ai-form-row" data-testid="ai-form-row">
          <td colSpan={columns}>
            <AiReasonForm
              id={formId}
              next={next}
              reason={reason}
              problem={problem}
              failure={failure}
              sending={sending}
              t={t}
              onReason={setReason}
              onSubmit={submit}
              onCancel={close}
              reasonRef={reasonRef}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}
