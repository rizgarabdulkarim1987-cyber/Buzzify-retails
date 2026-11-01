import { expect, test, type Page } from "@playwright/test";
import { LONG_PRODUCT_NAME, OWNER, PASSWORD, STOCK_ITEM } from "./fixtures";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/retail\//);
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** The business's day (Asia/Baghdad, the seeded business's zone) plus `offset` days, as YYYY-MM-DD. */
function businessDay(offset: number): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Baghdad", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return new Date(Date.parse(`${today}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

test("the owner receives goods by scan and by name at 375px in Arabic, then sees the stock and the batch expiring soon", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, OWNER.email);

  // The receipt screen.
  await page.goto("/retail/stock/receive");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("receipt-form")).toHaveAttribute("data-kind", "RECEIPT");
  expect(await noHorizontalScroll(page)).toBe(true);
  const lines = page.getByTestId("receipt-line");
  const scan = page.getByTestId("receipt-scan");

  // Line 1 by its barcode, as a scanner types it: 2 cartons of 12 at 15,000 a carton, batch L-7, 7 days left.
  await scan.fill(STOCK_ITEM.barcode);
  await scan.press("Enter");
  await expect(lines).toHaveCount(1);
  const milk = lines.nth(0);
  await expect(milk).toContainText(STOCK_ITEM.nameAr);
  await milk.getByTestId("line-unit").selectOption({ label: STOCK_ITEM.carton });
  await milk.getByTestId("line-quantity").fill("2");
  await milk.getByTestId("line-cost").fill("15000");
  await milk.getByTestId("line-batch").fill("L-7");
  await milk.getByTestId("line-expiry").fill(businessDay(7));

  // Line 2 by its name (a long one): 5 pieces at 3,000.
  await scan.fill(LONG_PRODUCT_NAME.slice(0, 40));
  await scan.press("Enter");
  const hit = page.getByTestId("receipt-hit").filter({ hasText: LONG_PRODUCT_NAME.slice(0, 20) });
  await expect(lines.nth(1).or(hit.first())).toBeVisible();
  if ((await lines.count()) < 2) await hit.first().click();
  await expect(lines).toHaveCount(2);
  const powder = lines.nth(1);
  await powder.getByTestId("line-quantity").fill("5");
  await powder.getByTestId("line-cost").fill("3000");
  expect(await noHorizontalScroll(page)).toBe(true);

  // Post: the summary names the lines and the total (2 x 15,000 + 5 x 3,000 = 45,000 IQD).
  await page.getByTestId("receipt-post").click();
  await expect(page.getByTestId("receipt-done")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("receipt-done-lines")).toContainText("٢");
  await expect(page.getByTestId("receipt-done-total")).toContainText("٤٥٬٠٠٠");
  expect(await noHorizontalScroll(page)).toBe(true);

  // The stock list: 2 cartons on hand, expiring soon, with the value for the owner.
  await page.goto(`/retail/stock?q=${STOCK_ITEM.barcode}`);
  const row = page.getByTestId("stock-row").filter({ hasText: STOCK_ITEM.nameAr });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("stock-qty")).toHaveText(`٢ ${STOCK_ITEM.carton}`);
  await expect(row).toHaveAttribute("data-status", "SOON");
  await expect(row.getByTestId("stock-badge-soon")).toBeVisible();
  await expect(row.getByTestId("stock-value")).toContainText("٣٠٬٠٠٠");
  expect(await noHorizontalScroll(page)).toBe(true);

  // Expiring soon: the batch, 7 days left.
  await page.goto("/retail/stock/expiring");
  const batch = page.getByTestId("expiring-row").filter({ hasText: STOCK_ITEM.nameAr });
  await expect(batch).toHaveCount(1);
  await expect(batch).toContainText("L-7");
  await expect(batch).toContainText("٧");
  await expect(batch).toHaveAttribute("data-status", "SOON");
  expect(await noHorizontalScroll(page)).toBe(true);
});
