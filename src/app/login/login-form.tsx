"use client";

import { useActionState } from "react";
import { Notice } from "../_ui/state";
import { signIn, type SignInState } from "./actions";

type PasswordLabels = {
  email: string;
  password: string;
  submit: string;
  failed: string;
  throttled: string;
  loading: string;
};

type Labels = PasswordLabels & { signIn: string; coreFailed: string };

/**
 * The public sign-in: ONE "Sign in" button that starts the handoff (handoffHref is the handoff
 * start route, or null when the handoff is not configured). Without the handoff (a dev/test
 * environment) it falls back to the email + password form. coreError: a handoff just failed (no
 * detail is shown). The staff-only password form lives on /admin/login and is never linked here.
 */
export function LoginForm({ labels, handoffHref, coreError }: { labels: Labels; handoffHref: string | null; coreError: boolean }) {
  if (!handoffHref) return <PasswordForm labels={labels} notice={coreError ? labels.coreFailed : null} />;
  return (
    <div className="form">
      {coreError ? <Notice tone="danger">{labels.coreFailed}</Notice> : null}
      <a className="btn btn-primary btn-block" href={handoffHref} data-testid="handoff-sign-in">
        {labels.signIn}
      </a>
    </div>
  );
}

/** Email + password sign-in (throttled by the server action). notice: shown when no sign-in error is. */
export function PasswordForm({ labels, notice = null }: { labels: PasswordLabels; notice?: string | null }) {
  const [state, action, pending] = useActionState<SignInState, FormData>(signIn, { failed: null, email: "" });
  return (
    <form action={action} className="form">
      {state.failed ? (
        <Notice tone="danger">{state.failed === "THROTTLED" ? labels.throttled : labels.failed}</Notice>
      ) : notice ? (
        <Notice tone="danger">{notice}</Notice>
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
      <button className="btn btn-primary btn-block" type="submit" disabled={pending} aria-busy={pending}>
        {pending ? labels.loading : labels.submit}
      </button>
    </form>
  );
}
