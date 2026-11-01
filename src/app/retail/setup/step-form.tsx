"use client";

import { useActionState, useTransition, type ReactNode } from "react";
import type { Messages } from "@/messages";
import { Notice } from "../../_ui/state";
import { submitSetupStep, type SetupStepState } from "./actions";

type Props = {
  step: number;
  businessId: string;
  /** Fresh per render of the page: a double submit reuses it, so the step is saved once. */
  idempotencyKey: string;
  /** True while the business is read-only: the fields show but cannot be changed or sent. */
  disabled: boolean;
  t: Pick<Messages["setup"], "save" | "saving" | "saved" | "alreadySubmitted"> & Pick<Messages, "errors" | "internalError">;
  children: ReactNode;
};

/** The form around one wizard step's fields: submit, pending state, and the result notice. */
export function StepForm({ step, businessId, idempotencyKey, disabled, t, children }: Props) {
  const [state, action] = useActionState<SetupStepState, FormData>(submitSetupStep, { status: "idle" });
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="form"
      data-testid={`setup-form-${step}`}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(() => action(data));
      }}
    >
      <input type="hidden" name="step" value={step} />
      <input type="hidden" name="business" value={businessId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {state.status === "failed" ? (
        <Notice tone="danger">
          {state.code === "INTERNAL" ? t.internalError : state.code === "IDEMPOTENCY_MISMATCH" ? t.alreadySubmitted : t.errors[state.code]}
        </Notice>
      ) : null}
      {state.status === "saved" && !pending ? <Notice tone="success">{t.saved}</Notice> : null}
      {/* Keyed by the render's key: after a save the page re-renders and the fields show the stored values. */}
      <fieldset key={idempotencyKey} className="fieldset setup-fields" disabled={disabled || pending}>
        {children}
      </fieldset>
      <button type="submit" className="btn btn-primary" disabled={disabled || pending} aria-busy={pending}>
        {pending ? t.saving : t.save}
      </button>
    </form>
  );
}
