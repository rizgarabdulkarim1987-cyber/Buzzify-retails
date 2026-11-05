import { expect, test, type Page } from "@playwright/test";
import { CASHIER, INTAKE_ITEM, LONG_PRODUCT_BARCODE, PASSWORD, STOCK_ITEM, SUGAR, TERMINAL_A, USD_ITEM } from "./fixtures";
import { typeDigitsWhenReady } from "./keypad";

async function signIn(page: Page, email: string) {
  await page.goto("/admin/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
}

/** The document and the line table never scroll. */
const fixedScreen = (page: Page) =>
  page.evaluate(() => {
    const d = document.documentElement;
    const rows = document.querySelector('[data-testid="line-rows"]');
    return {
      page: d.scrollHeight <= d.clientHeight && d.scrollWidth <= d.clientWidth,
      rows: !rows || rows.scrollHeight <= rows.clientHeight + 1,
    };
  });

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scan-input");
  await input.fill(code);
  await input.press("Enter");
  await expect(input).toHaveValue("");
}

test.setTimeout(120_000);

test("the till is one fixed screen: lines page instead of scrolling, X removes with an undo, tabs hold a sale, the cashier has no expense key", async ({ page }) => {
  // Short on purpose: five lines do not fit, so the table must page.
  await page.setViewportSize({ width: 1280, height: 520 });
  await signIn(page, CASHIER.email);
  await expect(page).toHaveURL(/\/retail\/select/);
  await page.getByRole("button", { name: TERMINAL_A }).click();
  await expect(page.getByTestId("open-shift-form")).toBeVisible();
  await page.keyboard.type("10000");
  // An earlier spec's rate is pre-filled: clear it, so this shift takes dinars only (and closes without a dollar count).
  const ratePick = page.getByTestId("open-rate-pick");
  if (await ratePick.count()) {
    await ratePick.click();
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
  }
  await page.getByTestId("open-submit").click();
  await expect(page.getByTestId("till")).toBeVisible();

  for (const code of [SUGAR.barcode, LONG_PRODUCT_BARCODE, STOCK_ITEM.barcode, INTAKE_ITEM.barcode, USD_ITEM.barcode]) await scan(page, code);
  await expect(page.getByTestId("cart-total").first()).toContainText("٣٧٬٥٠٠");
  const fixed = await fixedScreen(page);
  expect(fixed).toEqual({ page: true, rows: true });
  await expect(page.getByTestId("page-next")).toBeVisible();
  await page.screenshot({ path: "test-results/one-screen-1280x520.png" });

  // The selected product shows its stock and expiry cards; the receipts and shift cards are there.
  await expect(page.getByTestId("product-card")).toBeVisible();
  await expect(page.getByTestId("shift-card")).toBeVisible();
  await expect(page.getByTestId("receipts-card")).toBeVisible();
  await expect(page.getByTestId("calculator")).toBeVisible();

  // X removes the line and Undo puts it back.
  const before = await page.getByTestId("cart-total").first().textContent();
  await page.getByTestId("row-remove").first().click();
  await expect(page.getByTestId("undo-bar")).toBeVisible();
  await expect(page.getByTestId("cart-total").first()).not.toHaveText(before!);
  await page.getByTestId("undo").click();
  await expect(page.getByTestId("cart-total").first()).toHaveText(before!);

  // Hold this sale and start another; come back and nothing is lost.
  await page.getByTestId("new-sale").click();
  await expect(page.getByTestId("cart-total").first()).toContainText("٠");
  await scan(page, SUGAR.barcode);
  await page.getByTestId("ticket-tab").first().click();
  await expect(page.getByTestId("cart-total").first()).toHaveText(before!);

  // A cashier has no expense key, not even in the menu.
  await page.getByTestId("till-menu").click();
  await expect(page.getByTestId("menu-panel")).toBeVisible();
  await expect(page.getByTestId("fn-expense")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The calculator works in place.
  await page.getByTestId("calc-7").click();
  await page.getByTestId("calc-+").click();
  await page.getByTestId("calc-5").click();
  await page.getByTestId("calc-=").click();
  await expect(page.getByTestId("calc-out")).toContainText("١٢");

  // Phone width: two fixed panes, still no scroll.
  await page.setViewportSize({ width: 375, height: 667 });
  expect(await fixedScreen(page)).toEqual({ page: true, rows: true });
  await page.getByTestId("pane-box").click();
  await expect(page.getByTestId("calculator")).toBeVisible();
  expect(await fixedScreen(page)).toEqual({ page: true, rows: true });
  await page.screenshot({ path: "test-results/one-screen-375-box.png" });
  await page.getByTestId("pane-sell").click();
  await page.screenshot({ path: "test-results/one-screen-375-sell.png" });

  // Close the shift (nothing sold): the drawer holds the opening cash.
  await page.goto("/retail/sell/close");
  await typeDigitsWhenReady(page, "close-counted", "10000");
  await page.getByTestId("close-submit").click();
  await expect(page.getByTestId("shift-closed")).toBeVisible();
});
