import { expect, test, type Page } from "@playwright/test";
import { MANAGER, PASSWORD, TERMINAL_A, USD_ITEM } from "./fixtures";
import { typeDigitsWhenReady } from "./keypad";

async function signIn(page: Page, email: string) {
  await page.goto("/admin/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
}

test.setTimeout(120_000);

test("a manager opens a shift without a rate, sets the dollar rate on the till, and then pays in dollars with the change in dinars", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await signIn(page, MANAGER.email);
  await expect(page).toHaveURL(/\/retail\/select/);
  await page.getByRole("button", { name: TERMINAL_A }).click();
  await expect(page.getByTestId("open-shift-form")).toBeVisible({ timeout: 30_000 });
  await page.keyboard.type("50000");
  // An earlier shift's rate is pre-filled: clear it, so this shift starts without dollars.
  const ratePick = page.getByTestId("open-rate-pick");
  if (await ratePick.count()) {
    await ratePick.click();
    for (let i = 0; i < 6; i++) await page.keyboard.press("Backspace");
  }
  await page.getByTestId("open-submit").click();
  await expect(page.getByTestId("till")).toBeVisible();

  // No rate yet: the pay column has no dollar method but offers the field to set it.
  await expect(page.getByTestId("pay-method-usd")).toHaveCount(0);
  await expect(page.getByTestId("rate-input")).toBeVisible();
  await page.getByTestId("rate-input").fill("1450");
  await page.getByTestId("rate-save").click();
  await expect(page.getByTestId("rate-now")).toContainText("١٬٤٥٠");

  // Dollars are now a payment method; 29,250 dinars is 20.18 dollars and the change comes back in dinars.
  const scan = page.getByTestId("scan-input");
  await scan.fill(USD_ITEM.barcode);
  await scan.press("Enter");
  await expect(page.getByTestId("cart-total").first()).toContainText("٢٩٬٢٥٠");
  await page.getByTestId("pay-method-usd").click();
  await expect(page.getByTestId("pay-usd-due")).toContainText("٢٠٫١٨");
  await page.getByTestId("pay-note-usd").first().click();
  await expect(page.getByTestId("pay-change")).toContainText("١١");
  await page.screenshot({ path: "test-results/set-rate-1366.png" });
  await page.getByTestId("pay-confirm").click();
  await expect(page.getByTestId("sell-receipt")).toBeVisible();
  await expect(page.getByTestId("receipt-usd")).toContainText("٢٠٫١٨");

  // Close: 50,000 - 11 dinars and 20.18 dollars.
  await page.goto("/retail/sell/close");
  await typeDigitsWhenReady(page, "close-counted", "49989");
  await page.getByTestId("close-counted-usd-pick").click();
  await page.keyboard.type("20.18");
  await page.getByTestId("close-submit").click();
  await expect(page.getByTestId("shift-closed")).toBeVisible();
});
