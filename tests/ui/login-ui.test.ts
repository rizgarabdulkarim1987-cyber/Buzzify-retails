import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ar } from "@/messages/ar";
import { ckb } from "@/messages/ckb";
import { en } from "@/messages/en";
import { studioSignInHref } from "@/server/core/handoff";
import { LoginForm, PasswordForm } from "../../src/app/login/login-form";

const labels = {
  email: en.auth.email,
  password: en.auth.password,
  submit: en.auth.submit,
  failed: en.auth.failed,
  throttled: en.auth.throttled,
  loading: en.common.loading,
  signIn: en.auth.signIn,
  coreFailed: en.auth.coreFailed,
};

const HANDOFF = "/api/core/v1/handoff/start";
const render = (handoffHref: string | null, coreError = false) =>
  renderToStaticMarkup(createElement(LoginForm, { labels, handoffHref, coreError }));

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CORE_BASE_URL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CORE_BASE_URL;
  else process.env.CORE_BASE_URL = saved;
});

describe("public login page: one plain way in", () => {
  it("with the handoff available, shows ONE Sign in button and no password form", () => {
    const html = render(HANDOFF);
    expect(html).toContain(`href="${HANDOFF}"`);
    expect(html).toContain(`>${en.auth.signIn}<`);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).not.toContain("<button");
    expect(html).not.toContain('name="password"');
    expect(html).not.toContain('name="email"');
    // No divider, no other product's name, and no link to the staff-only form.
    expect(html).not.toContain("auth-or");
    expect(html).not.toMatch(/studio/i);
    expect(html).not.toContain("/admin/login");
  });

  it("without the handoff (dev/test), falls back to the email and password form", () => {
    const html = render(null);
    expect(html).not.toContain(HANDOFF);
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).toContain(en.auth.submit);
  });

  it("shows the failure notice after a failed handoff, without details", () => {
    expect(render(HANDOFF, true)).toContain(en.auth.coreFailed);
    expect(render(HANDOFF, false)).not.toContain(en.auth.coreFailed);
  });

  it("the handoff is offered exactly when CORE_BASE_URL is configured", () => {
    delete process.env.CORE_BASE_URL;
    expect(studioSignInHref()).toBeNull();
    process.env.CORE_BASE_URL = "   ";
    expect(studioSignInHref()).toBeNull();
    process.env.CORE_BASE_URL = "https://buzzify.example";
    expect(studioSignInHref()).toBe(HANDOFF);
  });

  it("the button reads Sign in in every locale", () => {
    expect(en.auth.signIn).toBe("Sign in");
    expect(ar.auth.signIn).toBe("دخول");
    expect(ckb.auth.signIn).toBe("چوونەژوورەوە");
    for (const m of [ar, ckb, en]) expect(m.auth.coreFailed.trim().length).toBeGreaterThan(0);
  });
});

describe("staff-only password form (/admin/login)", () => {
  it("is the email and password form, never the handoff", () => {
    const html = renderToStaticMarkup(createElement(PasswordForm, { labels }));
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).toContain('type="submit"');
    expect(html).not.toContain(HANDOFF);
  });
});
