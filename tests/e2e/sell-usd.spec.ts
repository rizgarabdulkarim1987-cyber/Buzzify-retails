import { expect, test, type Page } from "@playwright/test";
import { CASHIER, PASSWORD, TERMINAL_A, USD_ITEM } from "./fixtures";
import { typeDigitsWhenReady } from "./keypad";

async function signIn(page: Page, email: string) {
  await page.goto("/admin/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("a cashier opens a shift with dollars and a rate, takes 20.18 dollars for a 29,250 dinar sale, and closes both drawers", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, CASHIER.email);
  await expect(page).toHaveURL(/\/retail\/select/);
  await page.getByRole("button", { name: TERMINAL_A }).click();

  // Open: 50,000 dinars, 100 dollars and the day's rate.
  await expect(page.getByTestId("open-shift-form")).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.keyboard.type("50000");
  await page.getByTestId("open-usd-pick").click();
  await page.keyboard.type("100");
  await page.getByTestId("open-rate-pick").click();
  await page.keyboard.type("1450");
  await expect(page.getByTestId("open-rate")).toContainText("١٬٤٥٠");
  await page.getByTestId("open-submit").click();
  await expect(page.getByTestId("till")).toBeVisible();

  // Sell one item (29,250 dinars) by barcode and pay in dollars.
  const scan = page.getByTestId("scan-input");
  await scan.fill(USD_ITEM.barcode);
  await scan.press("Enter");
  await expect(page.getByTestId("cart-total").first()).toContainText("٢٩٬٢٥٠");
  await page.getByTestId("cart-pay").first().click();
  await expect(page.getByTestId("pay-panel")).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByTestId("pay-method-usd").click();
  await expect(page.getByTestId("pay-usd-due")).toContainText("٢٠٫١٨");
  await expect(page.getByTestId("pay-usd-due")).toContainText("١٬٤٥٠");
  // The exact chip: 20.18 dollars covers 29,250 dinars (20.17 would be 4 dinars short); change is a few dinars.
  await page.getByTestId("pay-note-usd").first().click();
  await expect(page.getByTestId("pay-given-usd")).toContainText("٢٠٫١٨");
  await expect(page.getByTestId("pay-change")).toContainText("١١");
  await page.screenshot({ path: "test-results/usd-pay-375.png" });
  await page.getByTestId("pay-confirm").click();

  // The receipt: dollars taken, the rate, the change in dinars.
  await expect(page.getByTestId("sell-receipt")).toBeVisible();
  await expect(page.getByTestId("receipt-usd")).toContainText("٢٠٫١٨");
  await expect(page.getByTestId("done-change")).toContainText("١١");
  await page.screenshot({ path: "test-results/usd-receipt-375.png", fullPage: true });

  // Close: the dinar drawer is 50,000 - 11; the dollar drawer is 100 + 20.18.
  await page.goto("/retail/sell/close");
  await expect(page.getByTestId("summary-expected")).toContainText("٤٩٬٩٨٩");
  await expect(page.getByTestId("summary-expected-usd")).toContainText("١٢٠٫١٨");
  await typeDigitsWhenReady(page, "close-counted", "49989");
  await page.getByTestId("close-counted-usd-pick").click();
  await page.keyboard.type("120.18");
  await expect(page.getByTestId("close-difference")).toContainText("مطابق");
  await expect(page.getByTestId("close-difference-usd")).toContainText("مطابق");
  await page.screenshot({ path: "test-results/usd-close-375.png", fullPage: true });
  await page.getByTestId("close-submit").click();
  await expect(page.getByTestId("shift-closed")).toBeVisible();
});

test("the next shift's form pre-fills the last rate, and the first digit typed replaces it", async ({ page }) => {
  await signIn(page, CASHIER.email);
  await expect(page).toHaveURL(/\/retail\/select/);
  await page.getByRole("button", { name: TERMINAL_A }).click();
  await expect(page.getByTestId("open-shift-form")).toBeVisible();
  // The previous test closed a shift with the rate 1,450.
  await expect(page.getByTestId("open-rate")).toContainText("١٬٤٥٠");
  await page.getByTestId("open-rate-pick").click();
  await page.keyboard.type("1460");
  await expect(page.getByTestId("open-rate")).toContainText("١٬٤٦٠");
  await expect(page.getByTestId("open-submit")).toBeEnabled();
});
