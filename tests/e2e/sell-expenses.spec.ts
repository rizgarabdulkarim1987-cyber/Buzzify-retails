import { expect, test, type Page } from "@playwright/test";
import { MANAGER, PASSWORD, TERMINAL_A } from "./fixtures";
import { typeDigitsWhenReady } from "./keypad";

async function signIn(page: Page, email: string) {
  await page.goto("/admin/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** Signs in, picks the terminal and opens a shift with the given opening dinars. */
async function openShiftWith(page: Page, email: string, opening: string) {
  await signIn(page, email);
  await expect(page).toHaveURL(/\/retail\/select/);
  await page.getByRole("button", { name: TERMINAL_A }).click();
  await expect(page.getByTestId("open-shift-form")).toBeVisible();
  await page.keyboard.type(opening);
  await page.getByTestId("open-submit").click();
  await expect(page.getByTestId("till")).toBeVisible();
}

/** Managers and owners reach the Expense panel from the till's menu (a cashier's till has no expense key). */
async function openExpensePanel(page: Page) {
  await page.getByTestId("till-menu").click();
  await page.getByTestId("fn-expense").click();
}

test("a manager records expenses at 375px in Arabic and closes with the expected cash reduced", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await openShiftWith(page, MANAGER.email, "50000");

  // The Expense key is in the till's menu for the manager.
  await openExpensePanel(page);
  await expect(page.getByTestId("expense-panel")).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await expect(page.getByTestId("expense-save")).toBeDisabled();

  // The fixed Save button never covers the last keypad row once it is scrolled into view.
  await page.getByTestId("expense-panel").getByTestId("key-back").scrollIntoViewIfNeeded();
  const key = await page.getByTestId("expense-panel").getByTestId("key-back").boundingBox();
  const save = await page.getByTestId("expense-save").boundingBox();
  expect(key!.y + key!.height).toBeLessThanOrEqual(save!.y + 1);
  expect(save!.height).toBeGreaterThanOrEqual(44);

  // 5,000 for transport.
  await page.keyboard.type("5000");
  await expect(page.getByTestId("expense-amount-display")).toContainText("٥٬٠٠٠");
  await expect(page.getByTestId("expense-save")).toBeDisabled();
  await page.getByTestId("expense-cat-TRANSPORT").click();
  await expect(page.getByTestId("expense-save")).toBeEnabled();
  await page.screenshot({ path: "test-results/expenses-panel-375.png" });
  // Two quick taps on Save record one expense.
  await page.getByTestId("expense-save").dblclick();
  await expect(page.getByTestId("expense-row")).toHaveCount(1);
  await expect(page.getByTestId("expense-row").first()).toContainText("٥٬٠٠٠");
  await expect(page.getByTestId("expense-amount-display")).toContainText("٠");

  // "Other" needs a note.
  await page.keyboard.type("1000");
  await page.getByTestId("expense-cat-OTHER").click();
  await expect(page.getByTestId("expense-save")).toBeDisabled();
  await page.getByTestId("expense-note").fill("ثلج");
  await expect(page.getByTestId("expense-save")).toBeEnabled();
  await page.getByTestId("expense-save").click();
  await expect(page.getByTestId("expense-row")).toHaveCount(2);

  // More than the drawer holds (50,000 - 6,000 = 44,000) is refused with the drawer message and records nothing.
  await page.getByTestId("expense-amount-box").scrollIntoViewIfNeeded();
  await page.keyboard.type("44001");
  await page.getByTestId("expense-cat-SUPPLIES").click();
  await page.getByTestId("expense-save").click();
  await expect(page.getByRole("alert").first()).toContainText("لا يوجد في الصندوق نقد يكفي");
  await expect(page.getByTestId("expense-row")).toHaveCount(2);

  await page.getByTestId("expense-back").click();
  await expect(page.getByTestId("expense-panel")).toHaveCount(0);

  // Close: 50,000 - 6,000 = 44,000 expected; counting 44,000 matches.
  await page.goto("/retail/sell/close");
  expect(await noHorizontalScroll(page)).toBe(true);
  await expect(page.getByTestId("summary-expenses")).toContainText("٦٬٠٠٠");
  await expect(page.getByTestId("summary-expected")).toContainText("٤٤٬٠٠٠");
  await page.getByTestId("close-expenses-toggle").click();
  await expect(page.getByTestId("expense-row")).toHaveCount(2);
  await page.getByTestId("close-expenses-toggle").click();
  await typeDigitsWhenReady(page, "close-counted", "44000");
  await expect(page.getByTestId("close-difference")).toContainText("مطابق");
  await page.screenshot({ path: "test-results/expenses-close-375.png", fullPage: true });
  await page.getByTestId("close-submit").click();
  await expect(page.getByTestId("shift-closed")).toBeVisible();
  await expect(page.getByTestId("summary-expenses")).toContainText("٦٬٠٠٠");
});

test("a manager voids a mistaken expense with a reason; it stays struck through and no longer counts", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openShiftWith(page, MANAGER.email, "20000");
  await openExpensePanel(page);
  await page.keyboard.type("3000");
  await page.getByTestId("expense-cat-SUPPLIES").click();
  await page.getByTestId("expense-save").click();
  await expect(page.getByTestId("expense-row")).toHaveCount(1);

  await page.getByTestId("expense-void").click();
  await expect(page.getByTestId("expense-void-confirm")).toBeDisabled();
  await page.getByTestId("expense-void-reason").fill("مبلغ خاطئ");
  await page.getByTestId("expense-void-confirm").click();
  await expect(page.getByTestId("expense-voided")).toContainText("مبلغ خاطئ");
  await expect(page.getByTestId("expense-void")).toHaveCount(0);
  await page.screenshot({ path: "test-results/expenses-void-375.png" });

  // The voided expense is free again: the whole 20,000 can be spent, and the close does not subtract the voided one.
  await page.getByTestId("expense-back").click();
  await page.goto("/retail/sell/close");
  await expect(page.getByTestId("summary-expenses")).toHaveCount(0);
  await expect(page.getByTestId("summary-expected")).toContainText("٢٠٬٠٠٠");
  await typeDigitsWhenReady(page, "close-counted", "20000");
  await expect(page.getByTestId("close-counted")).toContainText("٢٠٬٠٠٠");
  await page.getByTestId("close-submit").click();
  await expect(page.getByTestId("shift-closed")).toBeVisible();
});
