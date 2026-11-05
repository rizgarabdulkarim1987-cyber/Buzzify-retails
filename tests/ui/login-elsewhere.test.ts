import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ar } from "@/messages/ar";
import { ckb } from "@/messages/ckb";
import { en } from "@/messages/en";
import { HANDOFF_START_PATH } from "@/server/core/handoff";
import { FORBIDDEN, visibleText } from "../helpers/own-words";

/*
 * After a right password for an account this form may not sign in (Studio answered "unavailable":
 * a platform account, or one the handoff turns away), the password step says so and offers one
 * primary link to the browser handoff, which takes the person to Studio's own sign-in page.
 */

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useActionState: () => [{ step: "password", failed: "ELSEWHERE", email: "root@example.test", shops: [] }, () => undefined, false],
  };
});

const { AccountSignInForm } = await import("@/app/login/login-form");

describe("the password step after an ELSEWHERE answer", () => {
  for (const [locale, m] of [["ar", ar], ["ckb", ckb], ["en", en]] as const) {
    it(`${locale}: says the account signs in on its own page and links to the browser handoff`, () => {
      const a = m.auth;
      const labels = {
        email: a.email, password: a.password, submit: a.submit, failed: a.failed, throttled: a.throttled, loading: m.common.loading,
        forgot: a.forgot, showPassword: a.showPassword, hidePassword: a.hidePassword, codeIntro: a.codeIntro, code: a.code,
        codeSubmit: a.codeSubmit, codeFailed: a.codeFailed, expired: a.expired, startOver: a.startOver, chooseIntro: a.chooseIntro,
        chooseSubmit: a.chooseSubmit, notReady: a.notReady, preparing: a.preparing, unavailable: a.unavailable,
        elsewhere: a.elsewhere, elsewhereAction: a.elsewhereAction, coreFailed: a.coreFailed,
      };
      const html = renderToStaticMarkup(createElement(AccountSignInForm, { labels, forgotHref: null, elsewhereHref: HANDOFF_START_PATH }));
      expect(html).toContain(a.elsewhere);
      expect(html).toMatch(new RegExp(`<a class="btn btn-primary btn-block" href="${HANDOFF_START_PATH}" data-testid="signin-elsewhere">${a.elsewhereAction}</a>`));
      for (const { pattern } of FORBIDDEN) expect(visibleText(html)).not.toMatch(pattern);
    });
  }
});
