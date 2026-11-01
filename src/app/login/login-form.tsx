"use client";

import { useActionState } from "react";
import { Notice } from "../_ui/state";
import { signIn, type SignInState } from "./actions";

type Labels = {
  email: string;
  password: string;
  submit: string;
  failed: string;
  throttled: string;
  loading: string;
  studio: string;
  or: string;
  coreFailed: string;
};

/**
 * Email + password sign-in, and "Sign in with Studio" when Studio is configured (studioHref is
 * the handoff start route, or null). coreError: a Studio handoff just failed (no detail is shown).
 */
export function LoginForm({ labels, studioHref, coreError }: { labels: Labels; studioHref: string | null; coreError: boolean }) {
  const [state, action, pending] = useActionState<SignInState, FormData>(signIn, { failed: null, email: "" });
  return (
    <form action={action} className="form">
      {state.failed ? (
        <Notice tone="danger">{state.failed === "THROTTLED" ? labels.throttled : labels.failed}</Notice>
      ) : coreError ? (
        <Notice tone="danger">{labels.coreFailed}</Notice>
      ) : null}
      {studioHref ? (
        <>
          <a className="btn btn-primary btn-block" href={studioHref} data-testid="studio-sign-in">
            {labels.studio}
          </a>
          <p className="auth-or muted" aria-hidden="true">
            {labels.or}
          </p>
        </>
      ) : null}
      <label className="field">
        <span>{labels.email}</span>
        <input
          className="input"
          type="email"
          name="email"
          dir="ltr"
          autoComplete="username"
          required
          defaultValue={state.email}
          maxLength={254}
        />
      </label>
      <label className="field">
        <span>{labels.password}</span>
        <input className="input" type="password" name="password" dir="ltr" autoComplete="current-password" required />
      </label>
      <button className={`btn ${studioHref ? "btn-secondary" : "btn-primary"} btn-block`} type="submit" disabled={pending} aria-busy={pending}>
        {pending ? labels.loading : labels.submit}
      </button>
    </form>
  );
}
