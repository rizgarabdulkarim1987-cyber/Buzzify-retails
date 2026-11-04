import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirOf, type Locale } from "@/messages";
import { ar } from "@/messages/ar";
import { ckb } from "@/messages/ckb";
import { en } from "@/messages/en";
import { resetPasswordHref } from "@/server/core/handoff";
import { FORBIDDEN, visibleText } from "../helpers/own-words";

/*
 * The public /login page: Retails' own email and password form beside a calm panel, in each
 * locale, reading only Retails' own words. Next's request APIs are replaced by a fixed locale
 * cookie and no session; the page and its client form render as on the server.
 */

const state = vi.hoisted(() => ({ locale: "ar" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "rt_locale" ? { name, value: state.locale } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock("@/server/auth/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/auth")>()),
  getSessionUserId: async () => null,
}));

const { default: LoginPage } = await import("@/app/login/page");
const { PasswordForm } = await import("@/app/login/login-form");

const STUDIO = "https://accounts.example";
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CORE_BASE_URL;
  process.env.CORE_BASE_URL = STUDIO;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CORE_BASE_URL;
  else process.env.CORE_BASE_URL = saved;
});

async function render(locale: Locale, error?: string): Promise<string> {
  state.locale = locale;
  const page = await LoginPage({ searchParams: Promise.resolve(error ? { error } : {}) });
  return renderToStaticMarkup(page);
}

const MESSAGES = { ar, ckb, en } as const;

describe("public login page: Retails' own form", () => {
  for (const locale of ["ar", "ckb", "en"] as const) {
    const m = MESSAGES[locale];

    it(`${locale}: email, password with a show/hide eye, forgot link and one primary Sign in`, async () => {
      const html = await render(locale);
      expect(html).toMatch(/<input[^>]*type="email"[^>]*name="email"/);
      expect(html).toMatch(/<input[^>]*id="password"[^>]*type="password"[^>]*name="password"/);
      expect(html).toMatch(/autoComplete="current-password"|autocomplete="current-password"/);
      expect(html).toContain(`aria-label="${m.auth.showPassword}"`);
      expect(html).toContain('aria-pressed="false"');
      expect(html).toContain('aria-controls="password"');
      // The eye is a plain button: it never submits the form.
      expect(html).toMatch(/<button type="button" class="input-reveal-toggle"/);
      expect(html.match(/type="submit"/g)).toHaveLength(1);
      expect(html).toMatch(new RegExp(`class="btn btn-primary btn-block" type="submit"[^>]*>${m.auth.submit}<`));
      expect(html).toContain(`>${m.auth.forgot}</a>`);
      expect(html).toContain(`>${m.auth.email}<`);
      expect(html).toContain(`>${m.auth.password}</label>`);
      // Email and password are typed left to right even in Arabic and Kurdish.
      expect(html).toMatch(/name="email"[^>]*dir="ltr"|dir="ltr"[^>]*name="email"/);
      // Nothing links to the staff-only form or starts the old browser handoff.
      expect(html).not.toContain("/admin/login");
      expect(html).not.toContain("/api/core/v1/handoff/start");
    });

    it(`${locale}: a visitor reads no other product's name and no internal service`, async () => {
      for (const error of [undefined, "core"]) {
        const text = visibleText(await render(locale, error));
        for (const { word, pattern } of FORBIDDEN) expect(text, `${locale}: ${word}`).not.toMatch(pattern);
      }
    });

    it(`${locale}: the panel says sales, stock and shifts in all three languages`, async () => {
      const html = await render(locale);
      expect(html).toContain('<aside class="auth-aside">');
      expect(html).toContain(m.auth.aside);
      expect(html).toContain('lang="en"><span dir="ltr" class="auth-line">Sales, stock and shifts</span>');
      expect(html).toContain('lang="ar"><span dir="rtl" class="auth-line">المبيعات والمخزون والورديات</span>');
      expect(html).toContain('lang="ckb"><span dir="rtl" class="auth-line">فرۆشتن، کۆگا و شیفتەکان</span>');
    });
  }

  it("the visible-text check reads text and spoken labels, not link targets", () => {
    const text = visibleText('<a href="https://x/studio/forgot">Go</a><button aria-label="Studio eye">x</button>');
    expect(text).toBe("Go x Studio eye");
  });

  it("is right to left in Arabic and Kurdish (the root layout sets dir), left to right in English", () => {
    expect(dirOf("ar")).toBe("rtl");
    expect(dirOf("ckb")).toBe("rtl");
    expect(dirOf("en")).toBe("ltr");
  });

  it("shows the generic notice after a failed browser handoff, without details", async () => {
    expect(await render("en", "core")).toContain(en.auth.coreFailed);
    expect(await render("en")).not.toContain(en.auth.coreFailed);
  });

  it("sends a forgotten password to the reset page with the Retail marker, and offers none without the account system", async () => {
    const html = await render("en");
    const href = `${STUDIO}/studio/forgot?next=%2Fstudio%2Fretail%2Fcontinue`;
    expect(resetPasswordHref()).toBe(href);
    expect(html).toContain(`href="${href}"`);
    process.env.CORE_BASE_URL = `${STUDIO}/`;
    expect(resetPasswordHref()).toBe(href);
    delete process.env.CORE_BASE_URL;
    expect(resetPasswordHref()).toBeNull();
    expect(await render("en")).not.toContain(en.auth.forgot);
  });
});

describe("the sign-in layout (globals.css)", () => {
  const css = readFileSync("src/app/globals.css", "utf8");
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
  };

  it("is one column on phones: the panel is hidden below 64rem and appears beside the form above it", () => {
    expect(block(".auth-aside")).toContain("display: none");
    const wide = css.slice(css.indexOf("@media (min-width: 64rem) {\n  .auth-split"));
    expect(wide).toMatch(/\.auth-split \{\s*grid-template-columns: minmax\(0, 1fr\) minmax\(25rem, 40%\);/);
    expect(wide).toMatch(/\.auth-aside \{\s*display: flex;/);
    expect(block(".auth-form")).toContain("max-width: 24rem");
  });

  it("uses logical sides only, so the eye and the panel's border follow the reading direction", () => {
    expect(block(".input-reveal-toggle")).toContain("inset-inline-end: 0");
    expect(block(".input-reveal .input")).toContain("padding-inline-end");
    for (const sel of [".auth-split", ".auth-main", ".input-reveal-toggle", ".input-reveal .input", ".auth-lines li"]) {
      expect(block(sel), sel).not.toMatch(/\b(left|right)\b|margin-left|margin-right|padding-left|padding-right/);
    }
    expect(css).toMatch(/\.auth-aside \{[^}]*border-inline-start: 1px solid/);
  });
});

describe("staff-only password form (/admin/login)", () => {
  it("is the plain email and password form, with no reset link and no handoff", () => {
    const labels = {
      email: en.auth.email,
      password: en.auth.password,
      submit: en.auth.submit,
      failed: en.auth.failed,
      throttled: en.auth.throttled,
      loading: en.common.loading,
    };
    const html = renderToStaticMarkup(createElement(PasswordForm, { labels }));
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).toContain('type="submit"');
    expect(html).not.toContain(en.auth.forgot);
    expect(html).not.toContain("/api/core/v1/handoff/start");
  });

  it("keeps its page", () => {
    const source = readFileSync("src/app/admin/login/page.tsx", "utf8");
    expect(source).toContain("<PasswordForm");
    expect(source).not.toContain("AccountSignInForm");
  });
});
