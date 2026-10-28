"use client";

import { useActionState, useEffect, useRef, useTransition } from "react";
import type { Messages } from "@/messages";
import type { DirectoryPlan } from "@/server/admin/directory";
import { ACTIVITY_TYPES, CAPABILITIES } from "@/server/domain/profiles";
import { Notice } from "../_ui/state";
import { createBusiness, type CreateBusinessState } from "./actions";

type Props = {
  t: Pick<Messages, "adminForm" | "activity" | "capability" | "currency" | "errors" | "internalError">;
  plans: DirectoryPlan[];
  /** Fresh per render of the page: a double submit of this form reuses it, so one business is created. */
  idempotencyKey: string;
};

export function CreateBusinessForm({ t, plans, idempotencyKey }: Props) {
  const [state, action] = useActionState<CreateBusinessState, FormData>(createBusiness, { status: "idle" });
  const [pending, startTransition] = useTransition();
  const form = useRef<HTMLFormElement>(null);
  // Submitted through a transition (not the form action prop) so a refused submit keeps what was typed.
  useEffect(() => {
    if (state.status === "created") form.current?.reset();
  }, [state]);
  const f = t.adminForm;
  const disabled = pending || plans.length === 0;

  return (
    <form
      ref={form}
      className="form"
      data-testid="create-business-form"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(() => action(data));
      }}
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {state.status === "failed" ? (
        <Notice tone="danger">
          {state.code === "INTERNAL"
            ? t.internalError
            : state.code === "IDEMPOTENCY_MISMATCH"
              ? f.alreadySubmitted
              : t.errors[state.code]}
        </Notice>
      ) : null}
      {state.status === "created" ? <Notice tone="success">{f.created}</Notice> : null}
      {plans.length === 0 ? <Notice tone="danger">{f.noPlans}</Notice> : null}

      <label className="field">
        <span>{f.name}</span>
        <input className="input" name="name" required maxLength={120} autoComplete="organization" />
      </label>

      <div className="field-row">
        <label className="field">
          <span>{f.activityType}</span>
          <select className="input" name="activityType" required defaultValue="MARKET">
            {ACTIVITY_TYPES.map((a) => (
              <option key={a} value={a}>
                {t.activity[a]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{f.plan}</span>
          <select className="input" name="planCode" required disabled={plans.length === 0}>
            {plans.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="field">
        <span>{f.branches}</span>
        <textarea className="input" name="branches" required rows={3} />
        <span className="hint">{f.branchesHint}</span>
      </label>

      <label className="field">
        <span>{f.ownerEmail}</span>
        <input className="input" type="email" name="ownerEmail" dir="ltr" required maxLength={254} autoComplete="off" />
        <span className="hint">{f.ownerEmailHint}</span>
      </label>

      <div className="field-row">
        <label className="field">
          <span>{f.defaultCurrency}</span>
          <select className="input" name="defaultCurrency" defaultValue="IQD">
            <option value="IQD">{t.currency.IQD}</option>
            <option value="USD">{t.currency.USD}</option>
          </select>
        </label>
        <label className="field">
          <span>{f.trialDays}</span>
          <input className="input" type="number" name="trialDays" min={1} max={90} defaultValue={14} required inputMode="numeric" />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" name="secondCurrency" defaultChecked />
        {f.secondCurrency}
      </label>

      <fieldset className="fieldset">
        <legend>{f.capabilities}</legend>
        <span className="hint">{f.capabilitiesHint}</span>
        <div className="check-grid">
          {CAPABILITIES.map((c) => (
            <label key={c} className="check">
              <input type="checkbox" name="capabilities" value={c} />
              {t.capability[c]}
            </label>
          ))}
        </div>
      </fieldset>

      <button type="submit" className="btn btn-primary btn-block" disabled={disabled} aria-busy={pending}>
        {pending ? f.submitting : f.submit}
      </button>
    </form>
  );
}
