import type { FormEvent, Ref } from "react";
import type { Messages } from "@/messages";
import { Notice } from "../_ui/state";
import { AI_REASON_MAX, AI_REASON_MIN, type AiReasonProblem } from "./ai-switch-rules";

type T = Pick<Messages, "adminAi">;

/** The switch's current state for one business. */
export function AiStateBadge({ enabled, t }: { enabled: boolean; t: T }) {
  return (
    <span className="badge" data-tone={enabled ? "accent" : undefined} data-state={enabled ? "on" : "off"} data-testid="ai-state">
      {enabled ? t.adminAi.on : t.adminAi.off}
    </span>
  );
}

type FormProps = {
  /** Prefix of the element ids (unique per business). */
  id: string;
  /** The state this form moves the business to. */
  next: boolean;
  reason: string;
  problem: AiReasonProblem | null;
  /** A refusal, already in the UI locale. */
  failure: string | null;
  sending: boolean;
  t: T;
  onReason(value: string): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  onCancel(): void;
  reasonRef?: Ref<HTMLTextAreaElement>;
};

/**
 * The reason the change needs (audited with it). While a change is on its way the buttons stay
 * focusable but inert (aria-disabled), so focus never drops to the page.
 */
export function AiReasonForm({ id, next, reason, problem, failure, sending, t, onReason, onSubmit, onCancel, reasonRef }: FormProps) {
  const a = t.adminAi;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  return (
    <form id={id} className="form ai-switch-form" onSubmit={onSubmit} noValidate data-testid="ai-switch-form">
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
      <label className="field">
        <span>{a.reason}</span>
        <textarea
          ref={reasonRef}
          className="input"
          name="reason"
          rows={2}
          required
          minLength={AI_REASON_MIN}
          maxLength={AI_REASON_MAX}
          value={reason}
          onChange={(event) => onReason(event.currentTarget.value)}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${errorId} ${hintId}` : hintId}
          data-testid="ai-switch-reason"
        />
        {problem ? (
          <span id={errorId} className="field-error">
            {problem === "REASON_SHORT" ? a.reasonShort : a.reasonLong}
          </span>
        ) : null}
        <span id={hintId} className="hint">
          {a.reasonHint}
        </span>
      </label>
      <div className="ai-switch-actions">
        <button
          type="submit"
          className={next ? "btn btn-primary btn-small" : "btn btn-secondary btn-danger btn-small"}
          aria-disabled={sending || undefined}
          aria-busy={sending || undefined}
          data-testid="ai-switch-confirm"
        >
          {sending ? a.sending : next ? a.confirmEnable : a.confirmDisable}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          onClick={onCancel}
          aria-disabled={sending || undefined}
          data-testid="ai-switch-cancel"
        >
          {a.cancel}
        </button>
      </div>
    </form>
  );
}
