import { expect, test } from "@playwright/test";
import { ar } from "../../src/messages/ar";
import { ckb } from "../../src/messages/ckb";
import { en } from "../../src/messages/en";

for (const [locale, m] of [["ar", ar], ["ckb", ckb], ["en", en]] as const) {
  test(`login at 375px in ${locale}: one Sign in button, no password form, no horizontal scrolling`, async ({ page, context }) => {
    await context.addCookies([{ name: "rt_locale", value: locale, url: test.info().project.use.baseURL! }]);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/login?error=core");
    const button = page.getByTestId("handoff-sign-in");
    await expect(button).toHaveText(m.auth.signIn);
    await expect(button).toHaveAttribute("href", "/api/core/v1/handoff/start");
    await expect(page.getByText(m.auth.coreFailed)).toBeVisible();
    await expect(page.locator('input[name="password"]')).toHaveCount(0);
    await expect(page.locator('a[href*="/admin/login"]')).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/studio/i);
    const box = await button.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375.5);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("the staff-only /admin/login keeps the email and password form", async ({ page }) => {
  await page.goto("/admin/login");
  await expect(page.locator('input[name="email"]')).toBeVisible();
  await expect(page.locator('input[name="password"]')).toBeVisible();
  await expect(page.getByTestId("handoff-sign-in")).toHaveCount(0);
});
