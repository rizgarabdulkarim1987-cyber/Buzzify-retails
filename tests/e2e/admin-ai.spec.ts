import { expect, test, type Page } from "@playwright/test";
import { ar } from "../../src/messages/ar";
import { ADMIN, BUSINESS, PASSWORD } from "./fixtures";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** The reason form opens in a row of its own under the business (one at a time here). */
const form = (page: Page) => page.getByTestId("ai-form-row");
const row = (page: Page) => page.getByTestId("business-table").locator("tr", { has: page.getByTitle(BUSINESS, { exact: true }) });

/** Moves the switch of the seeded business, giving `reason`, and waits for the new state. */
async function move(page: Page, to: "on" | "off", reason: string) {
  const r = row(page);
  await r.getByTestId("ai-switch-toggle").click();
  await expect(form(page).getByTestId("ai-switch-reason")).toBeFocused();
  await form(page).getByTestId("ai-switch-reason").fill(reason);
  await form(page).getByTestId("ai-switch-confirm").click();
  await expect(r.getByTestId("ai-state")).toHaveAttribute("data-state", to);
  await expect(r.getByTestId("ai-switch-toggle")).toBeFocused();
}

/**
 * The seeded shop's switch is shared by every e2e spec and later R1b specs assume it is off:
 * turn it off if an earlier, interrupted run left it on.
 */
async function ensureOff(page: Page) {
  await page.goto("/admin");
  const state = row(page).getByTestId("ai-state");
  await expect(state).toBeVisible();
  if ((await state.getAttribute("data-state")) === "on") await move(page, "off", "إعادة الحالة الافتراضية بعد الاختبار");
}

test.afterAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  try {
    const page = await context.newPage();
    await signIn(page, ADMIN.email);
    await ensureOff(page);
  } finally {
    await context.close();
  }
});

test("the platform admin turns a shop's AI reading on and off with a reason", async ({ page }) => {
  await signIn(page, ADMIN.email);
  await ensureOff(page);
  const r = row(page);
  await expect(r.getByTestId("ai-state")).toHaveAttribute("data-state", "off");
  await expect(r.getByTestId("ai-state")).toHaveText(ar.adminAi.off);

  // A short reason is refused in the browser; focus goes to the field.
  await r.getByTestId("ai-switch-toggle").click();
  await expect(r.getByTestId("ai-switch-toggle")).toHaveAttribute("aria-expanded", "true");
  await form(page).getByTestId("ai-switch-reason").fill("قصير");
  await form(page).getByTestId("ai-switch-confirm").click();
  await expect(form(page).getByText(ar.adminAi.reasonShort)).toBeVisible();
  await expect(form(page).getByTestId("ai-switch-reason")).toBeFocused();
  // Cancel closes the form and gives focus back to the button.
  await form(page).getByTestId("ai-switch-cancel").click();
  await expect(form(page).getByTestId("ai-switch-form")).toHaveCount(0);
  await expect(r.getByTestId("ai-switch-toggle")).toBeFocused();

  await move(page, "on", "تجربة القراءة بطلب المالك");
  await expect(r.getByText(ar.adminAi.doneOn)).toBeVisible();
  await expect(r.getByTestId("ai-state")).toHaveText(ar.adminAi.on);
  // The state survives a reload (it is read from the server).
  await page.reload();
  await expect(row(page).getByTestId("ai-state")).toHaveAttribute("data-state", "on");

  // Back to off, so the shared seed stays as it was (afterAll turns it off too if this test fails before here).
  await move(page, "off", "انتهت التجربة، إيقاف مؤقت");
  await expect(row(page).getByTestId("ai-state")).toHaveText(ar.adminAi.off);
});

test("at 375px the switch fits without horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, ADMIN.email);
  await page.goto("/admin");
  const r = row(page);
  await r.getByTestId("ai-switch-toggle").click();
  await expect(form(page).getByTestId("ai-switch-form")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await form(page).getByTestId("ai-switch-cancel").click();
});
