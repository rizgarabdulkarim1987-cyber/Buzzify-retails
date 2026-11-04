import { expect, test, type Page } from "@playwright/test";
import { ar } from "../../src/messages/ar";
import { ckb } from "../../src/messages/ckb";
import { en } from "../../src/messages/en";
import { FORBIDDEN } from "../helpers/own-words";
import { CORE_SHOP, PASSWORD, TWO_STEP } from "./fixtures";

/*
 * Retails' own sign-in form on /login, in a real browser: its fields, its words in each locale, its
 * layout at phone and desktop width, and a sign-in that goes through the fake Studio of
 * tests/e2e/fake-studio.ts (signed server-to-server calls, a real handoff token redeemed here).
 */

const MESSAGES = { ar, ckb, en } as const;

async function useLocale(page: Page, locale: keyof typeof MESSAGES) {
  await page.context().addCookies([{ name: "rt_locale", value: locale, url: test.info().project.use.baseURL! }]);
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const locale of ["ar", "ckb", "en"] as const) {
  const m = MESSAGES[locale];

  test(`login at 375px in ${locale}: its own form, its own words, one column`, async ({ page }) => {
    await useLocale(page, locale);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "en" ? "ltr" : "rtl");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(m.auth.title);
    await expect(page.getByLabel(m.auth.email)).toBeVisible();
    await expect(page.locator("#password")).toHaveAttribute("type", "password");
    await expect(page.getByRole("link", { name: m.auth.forgot })).toBeVisible();
    const submit = page.locator('button[type="submit"]');
    await expect(submit).toHaveText(m.auth.submit);
    // The calm panel stays off phones.
    await expect(page.locator(".auth-aside")).toBeHidden();
    const text = await page.locator("body").innerText();
    for (const { word, pattern } of FORBIDDEN) expect(text, word).not.toMatch(pattern);
    await expect(page.locator('a[href*="/admin/login"]')).toHaveCount(0);
    const box = await submit.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375.5);
    await noHorizontalScroll(page);
  });

  test(`login at 1280px in ${locale}: the form beside the panel of sales, stock and shifts`, async ({ page }) => {
    await useLocale(page, locale);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/login");
    const aside = page.locator(".auth-aside");
    await expect(aside).toBeVisible();
    await expect(aside).toContainText("Sales, stock and shifts");
    await expect(aside).toContainText("المبيعات والمخزون والورديات");
    await expect(aside).toContainText("فرۆشتن، کۆگا و شیفتەکان");
    const form = await page.locator(".auth-form").boundingBox();
    const panel = await aside.boundingBox();
    // The panel is on the end side: right of the form in English, left of it in Arabic and Kurdish.
    if (locale === "en") expect(panel!.x).toBeGreaterThan(form!.x + form!.width);
    else expect(panel!.x + panel!.width).toBeLessThan(form!.x);
    const text = await page.locator("body").innerText();
    for (const { word, pattern } of FORBIDDEN) expect(text, word).not.toMatch(pattern);
    await noHorizontalScroll(page);
  });
}

test("the eye shows and hides the password without submitting", async ({ page }) => {
  await useLocale(page, "en");
  await page.goto("/login");
  const password = page.locator("#password");
  await password.fill("typed-secret");
  const eye = page.getByTestId("password-toggle");
  await expect(eye).toHaveAttribute("aria-label", en.auth.showPassword);
  await eye.click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(eye).toHaveAttribute("aria-label", en.auth.hidePassword);
  await expect(eye).toHaveAttribute("aria-pressed", "true");
  await eye.click();
  await expect(password).toHaveAttribute("type", "password");
  await expect(page).toHaveURL(/\/login$/);
});

test("a wrong password says so generically and keeps the email, never the password", async ({ page }) => {
  await useLocale(page, "ar");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/login");
  await page.getByLabel(ar.auth.email).fill(CORE_SHOP.owner.email);
  await page.locator("#password").fill("not-the-password");
  await page.locator('button[type="submit"]').click();
  await expect(page.getByText(ar.auth.failed)).toBeVisible();
  await expect(page.getByLabel(ar.auth.email)).toHaveValue(CORE_SHOP.owner.email);
  await expect(page.locator("#password")).toHaveValue("");
  await expect(page).toHaveURL(/\/login$/);
});

test("the right password signs in through the account system and opens the shop (375px, Arabic)", async ({ page }) => {
  await useLocale(page, "ar");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/login");
  await page.getByLabel(ar.auth.email).fill(CORE_SHOP.owner.email);
  await page.locator("#password").fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  // Signed in: the shop's home, or the workplace chooser when other specs gave the owner more places.
  await expect(page).toHaveURL(/\/retail\/(home|select)/);
  await expect(page.getByText(CORE_SHOP.name).first()).toBeVisible();
  // The password never reached a URL.
  expect(page.url()).not.toContain(PASSWORD);
});

test("an account with two-step sign-in asks for the code, refuses a wrong one, then signs in (375px, Kurdish)", async ({ page, context }) => {
  await useLocale(page, "ckb");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/login");
  await page.getByLabel(ckb.auth.email).fill(TWO_STEP.email);
  await page.locator("#password").fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page.getByText(ckb.auth.codeIntro)).toBeVisible();
  const step = (await context.cookies()).find((c) => c.name === "rt_signin_step");
  expect(step?.httpOnly).toBe(true);
  expect(step?.path).toBe("/login");
  await noHorizontalScroll(page);

  await page.getByLabel(ckb.auth.code).fill("000000");
  await page.getByRole("button", { name: ckb.auth.codeSubmit }).click();
  await expect(page.getByText(ckb.auth.codeFailed)).toBeVisible();
  await page.getByLabel(ckb.auth.code).fill(TWO_STEP.code);
  await page.getByRole("button", { name: ckb.auth.codeSubmit }).click();
  await expect(page).toHaveURL(/\/retail\/(home|select)/);
});

test("the staff-only /admin/login keeps the email and password form", async ({ page }) => {
  await page.goto("/admin/login");
  await expect(page.locator('input[name="email"]')).toBeVisible();
  await expect(page.locator('input[name="password"]')).toBeVisible();
  await expect(page.getByTestId("forgot-password")).toHaveCount(0);
});
