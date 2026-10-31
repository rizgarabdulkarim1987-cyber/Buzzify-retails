import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ar } from "@/messages/ar";
import { ckb } from "@/messages/ckb";
import { en } from "@/messages/en";
import { studioSignInHref } from "@/server/core/handoff";
import { LoginForm } from "../../src/app/login/login-form";

const labels = {
  email: en.auth.email,
  password: en.auth.password,
  submit: en.auth.submit,
  failed: en.auth.failed,
  throttled: en.auth.throttled,
  loading: en.common.loading,
  studio: en.auth.studio,
  or: en.auth.or,
  coreFailed: en.auth.coreFailed,
};

const render = (studioHref: string | null, coreError = false) =>
  renderToStaticMarkup(createElement(LoginForm, { labels, studioHref, coreError }));

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CORE_BASE_URL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CORE_BASE_URL;
  else process.env.CORE_BASE_URL = saved;
});

describe("login form: sign in with Studio", () => {
  it("shows the Studio button (a link to the handoff start) only when enabled", () => {
    const on = render("/api/core/v1/handoff/start");
    expect(on).toContain('href="/api/core/v1/handoff/start"');
    expect(on).toContain(en.auth.studio);
    // Local password sign-in stays.
    expect(on).toContain('name="password"');

    const off = render(null);
    expect(off).not.toContain("/api/core/v1/handoff/start");
    expect(off).not.toContain(en.auth.studio);
    expect(off).toContain('name="password"');
  });

  it("shows the Studio failure notice after a failed handoff, without details", () => {
    expect(render("/api/core/v1/handoff/start", true)).toContain(en.auth.coreFailed);
    expect(render("/api/core/v1/handoff/start", false)).not.toContain(en.auth.coreFailed);
  });

  it("is enabled exactly when CORE_BASE_URL is configured", () => {
    delete process.env.CORE_BASE_URL;
    expect(studioSignInHref()).toBeNull();
    process.env.CORE_BASE_URL = "   ";
    expect(studioSignInHref()).toBeNull();
    process.env.CORE_BASE_URL = "https://studio.example";
    expect(studioSignInHref()).toBe("/api/core/v1/handoff/start");
  });

  it("has its strings in every locale", () => {
    for (const m of [ar, ckb, en]) {
      for (const k of ["studio", "or", "coreFailed"] as const) expect(m.auth[k].trim().length).toBeGreaterThan(0);
    }
  });
});
