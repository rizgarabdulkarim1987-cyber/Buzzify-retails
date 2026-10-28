"use client";

import { useActionState } from "react";
import { Notice } from "../_ui/state";
import { signIn, type SignInState } from "./actions";

type Labels = { email: string; password: string; submit: string; failed: string; throttled: string; loading: string };

export function LoginForm({ labels }: { labels: Labels }) {
  const [state, action, pending] = useActionState<SignInState, FormData>(signIn, { failed: null, email: "" });
  return (
    <form action={action} className="form">
      {state.failed ? <Notice tone="danger">{state.failed === "THROTTLED" ? labels.throttled : labels.failed}</Notice> : null}
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
