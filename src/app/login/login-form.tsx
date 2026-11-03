"use client";

import { useActionState, useState } from "react";
import { EyeIcon, EyeOffIcon } from "../_ui/icons";
import { Notice } from "../_ui/state";
import { signIn, signInWithAccount, type AccountSignInState, type SignInState } from "./actions";

type PasswordLabels = {
  email: string;
  password: string;
  submit: string;
  failed: string;
  throttled: string;
  loading: string;
};

export type AccountLabels = PasswordLabels & {
  forgot: string;
  showPassword: string;
  hidePassword: string;
  codeIntro: string;
  code: string;
  codeSubmit: string;
  codeFailed: string;
  expired: string;
  startOver: string;
  chooseIntro: string;
  chooseSubmit: string;
  notReady: string;
  preparing: string;
  unavailable: string;
  coreFailed: string;
};

/** The password input with a show/hide button. The button is a plain toggle: it never submits. */
function PasswordInput({ labels }: { labels: Pick<AccountLabels, "showPassword" | "hidePassword"> }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="input-reveal">
      <input
        id="password"
        className="input"
        type={shown ? "text" : "password"}
        name="password"
        dir="ltr"
        autoComplete="current-password"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
        maxLength={1024}
      />
      <button
        type="button"
        className="input-reveal-toggle"
        aria-label={shown ? labels.hidePassword : labels.showPassword}
        aria-pressed={shown}
        aria-controls="password"
        onClick={() => setShown((v) => !v)}
        data-testid="password-toggle"
      >
        {shown ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  );
}

function failureText(failed: AccountSignInState["failed"], labels: AccountLabels): string | null {
  switch (failed) {
    case null:
      return null;
    case "INVALID_CREDENTIALS":
      return labels.failed;
    case "THROTTLED":
      return labels.throttled;
    case "INVALID_CODE":
      return labels.codeFailed;
    case "EXPIRED":
      return labels.expired;
    case "PREPARING":
      return labels.preparing;
    case "UNAVAILABLE":
      return labels.unavailable;
    case "FAILED":
      return labels.coreFailed;
  }
}

/**
 * The public sign-in: email and password, then (when the account asks for it) a six-digit or
 * recovery code, then (for an owner of several businesses) the one to open. Every step posts to
 * the same server action; the password is never kept in the form's state. forgotHref: where
 * "Forgot your password?" goes, or null when there is nowhere to reset it. notice: shown before
 * the first attempt (a sign-in that just failed elsewhere).
 */
export function AccountSignInForm({ labels, forgotHref, notice = null }: { labels: AccountLabels; forgotHref: string | null; notice?: string | null }) {
  const [state, action, pending] = useActionState<AccountSignInState, FormData>(signInWithAccount, {
    step: "password",
    failed: null,
    email: "",
    shops: [],
  });
  const message = failureText(state.failed, labels) ?? (state.step === "password" ? notice : null);

  if (state.step === "code") {
    return (
      <form action={action} className="form" data-testid="signin-code">
        {message ? <Notice tone="danger">{message}</Notice> : null}
        <p className="muted auth-step-intro">{labels.codeIntro}</p>
        <input type="hidden" name="intent" value="code" />
        <input type="hidden" name="email" value={state.email} />
        <label className="field">
          <span>{labels.code}</span>
          <input
            className="input auth-code"
            name="code"
            dir="ltr"
            inputMode="text"
            autoComplete="one-time-code"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            maxLength={64}
            autoFocus
          />
        </label>
        <button className="btn btn-primary btn-block" type="submit" disabled={pending} aria-busy={pending}>
          {pending ? labels.loading : labels.codeSubmit}
        </button>
        <RestartButton label={labels.startOver} disabled={pending} />
      </form>
    );
  }

  if (state.step === "choose") {
    return (
      <form action={action} className="form" data-testid="signin-choose">
        {message ? <Notice tone="danger">{message}</Notice> : null}
        <p className="muted auth-step-intro">{labels.chooseIntro}</p>
        <input type="hidden" name="intent" value="choose" />
        <input type="hidden" name="email" value={state.email} />
        <fieldset className="fieldset auth-shops">
          <legend className="visually-hidden">{labels.chooseIntro}</legend>
          {state.shops.map((shop, i) => (
            <label key={shop.id} className="auth-shop">
              <input type="radio" name="shop" value={shop.id} defaultChecked={i === 0} required />
              <span className="auth-shop-name">{shop.name}</span>
              {shop.ready ? null : <span className="muted auth-shop-note">{labels.notReady}</span>}
            </label>
          ))}
        </fieldset>
        <button className="btn btn-primary btn-block" type="submit" disabled={pending} aria-busy={pending}>
          {pending ? labels.loading : labels.chooseSubmit}
        </button>
        <RestartButton label={labels.startOver} disabled={pending} />
      </form>
    );
  }

  return (
    <form action={action} className="form" data-testid="signin-password">
      {message ? <Notice tone="danger">{message}</Notice> : null}
      <input type="hidden" name="intent" value="password" />
      <label className="field">
        <span>{labels.email}</span>
        <input
          className="input"
          type="email"
          name="email"
          dir="ltr"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          defaultValue={state.email}
          maxLength={254}
        />
      </label>
      <div className="field">
        <div className="field-head">
          <label htmlFor="password">{labels.password}</label>
          {forgotHref ? (
            <a className="auth-forgot" href={forgotHref} data-testid="forgot-password">
              {labels.forgot}
            </a>
          ) : null}
        </div>
        <PasswordInput labels={labels} />
      </div>
      <button className="btn btn-primary btn-block" type="submit" disabled={pending} aria-busy={pending}>
        {pending ? labels.loading : labels.submit}
      </button>
    </form>
  );
}

/** Drops the pending step (and its challenge cookie) and shows the password step again. Skips the form's own checks. */
function RestartButton({ label, disabled }: { label: string; disabled: boolean }) {
  return (
    <button type="submit" name="restart" value="1" formNoValidate className="btn btn-secondary btn-block" disabled={disabled}>
      {label}
    </button>
  );
}

/** Email + password sign-in against local accounts (the staff-only /admin/login). notice: shown when no sign-in error is. */
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
