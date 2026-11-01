import { expect, test } from "@playwright/test";
import { ar } from "../../src/messages/ar";
import { ckb } from "../../src/messages/ckb";
import { en } from "../../src/messages/en";

for (const [locale, m] of [["ar", ar], ["ckb", ckb], ["en", en]] as const) {
  test(`login at 375px in ${locale}: Studio button and password form fit without horizontal scrolling`, async ({ page, context }) => {
    await context.addCookies([{ name: "rt_locale", value: locale, url: test.info().project.use.baseURL! }]);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/login?error=core");
    const studio = page.getByTestId("studio-sign-in");
    await expect(studio).toHaveText(m.auth.studio);
    await expect(studio).toHaveAttribute("href", "/api/core/v1/handoff/start");
    await expect(page.getByText(m.auth.coreFailed)).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
    const box = await studio.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375.5);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
