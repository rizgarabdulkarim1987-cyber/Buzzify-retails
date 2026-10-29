import { expect, test, type Page } from "@playwright/test";
import { en } from "../../src/messages/en";
import { CASHIER, LONG_PRODUCT_NAME, OWNER, PASSWORD, SUGAR } from "./fixtures";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/retail\//);
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("a keyboard-only user adds three products in a row by scanning barcodes", async ({ page }) => {
  await signIn(page, OWNER.email);
  await page.goto("/retail/catalog/new");
  const barcode = page.getByTestId("qe-barcode");
  await expect(barcode).toBeFocused();

  const items = [
    { code: "7000000000011", name: "شاي أحمر ١٠٠ غرام", price: "٢٥٠٠" },
    { code: "7000000000028", name: "رز بسمتي ٥ كغم", price: "1٢,000" },
    { code: "7000000000035", name: "زيت زيتون ٥٠٠ مل", price: "7,500" },
  ];
  for (const [i, item] of items.entries()) {
    // The scanner types the digits and Enter; nothing else touches the mouse.
    await page.keyboard.type(item.code);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("qe-name")).toBeFocused();
    await page.keyboard.type(item.name);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("qe-category")).toBeFocused();
    await page.keyboard.press("Enter"); // no category: skip to the price
    await expect(page.getByTestId("qe-price")).toBeFocused();
    await page.keyboard.type(item.price);
    await page.keyboard.press("Enter");
    // Saved: the form is empty again and the cursor is back on the barcode field.
    await expect(page.getByTestId("qe-added-item")).toHaveCount(i + 1);
    await expect(barcode).toBeFocused();
    await expect(barcode).toHaveValue("");
  }
  await expect(page.getByTestId("qe-added-item").first()).toContainText(items[2]!.name);

  // The three products are in the catalog.
  await page.goto("/retail/catalog");
  await page.getByTestId("catalog-search").fill("بسمتي");
  await expect(page.getByTestId("catalog-row")).toHaveCount(1);
  await expect(page.getByTestId("catalog-row")).toContainText("رز بسمتي ٥ كغم");
  await expect(page.getByTestId("catalog-row-price")).toContainText("١٢٬٠٠٠");
});

test("scanning an existing barcode opens that product instead of creating a duplicate", async ({ page }) => {
  await signIn(page, OWNER.email);
  await page.goto("/retail/catalog/new");
  await expect(page.getByTestId("qe-barcode")).toBeFocused();
  await page.keyboard.type(SUGAR.barcode);
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/retail\/catalog\/[A-Za-z0-9_-]+$/);
  await expect(page.getByTestId("product-name-ar")).toHaveValue(SUGAR.nameAr);

  await page.goto("/retail/catalog");
  await page.getByTestId("catalog-search").fill("سكر ناعم");
  await expect(page.getByTestId("catalog-row")).toHaveCount(1);
});

test("a cashier sees the catalog but no edit controls", async ({ page }) => {
  await signIn(page, CASHIER.email);
  await page.goto("/retail/catalog");
  await expect(page.getByTestId("catalog-row").filter({ hasText: SUGAR.nameAr })).toBeVisible();
  await expect(page.getByTestId("catalog-add")).toHaveCount(0);
  await expect(page.getByTestId("catalog-archived-toggle")).toHaveCount(0);

  // The quick-entry page refuses a cashier.
  await page.goto("/retail/catalog/new");
  await expect(page.getByTestId("state-forbidden")).toBeVisible();
  await expect(page.getByTestId("qe-barcode")).toHaveCount(0);

  // The product screen is read-only: values show, no controls.
  await page.goto("/retail/catalog");
  await page.getByTestId("catalog-row").filter({ hasText: SUGAR.nameAr }).getByRole("link").first().click();
  await expect(page.getByTestId("product-name-ar")).toHaveValue(SUGAR.nameAr);
  await expect(page.getByTestId("product-name-ar")).toBeDisabled();
  await expect(page.getByTestId("product-save")).toHaveCount(0);
  await expect(page.getByTestId("product-archive")).toHaveCount(0);
  await expect(page.getByTestId("unit-add-form")).toHaveCount(0);
  await expect(page.getByTestId("price-set-form")).toHaveCount(0);
});

test("a 120-character Arabic product name does not break the list at 375px", async ({ page }) => {
  expect(LONG_PRODUCT_NAME).toHaveLength(120);
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, OWNER.email);
  await page.goto("/retail/catalog");
  const row = page.getByTestId("catalog-row").filter({ hasText: LONG_PRODUCT_NAME.slice(0, 30) });
  await expect(row).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);

  const name = row.getByTestId("catalog-row-name");
  const box = await name.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375.5);
  // Cut with an ellipsis (or wrapped inside the row), never wider than the screen.
  const clipped = await name.evaluate((el) => {
    const s = getComputedStyle(el);
    return { overflow: s.overflow, wraps: el.scrollWidth <= el.clientWidth };
  });
  expect(clipped.wraps).toBe(true);

  // The quick-entry page and the product screen hold at this width too.
  await page.goto("/retail/catalog/new");
  await expect(page.getByTestId("qe-barcode")).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.goto("/retail/catalog");
  await row.getByRole("link").first().click();
  await expect(page.getByTestId("product-name-ar")).toHaveValue(LONG_PRODUCT_NAME);
  expect(await noHorizontalScroll(page)).toBe(true);
});

test("the list shows prices with the interface digits", async ({ page, context }) => {
  await signIn(page, OWNER.email);
  await page.goto("/retail/catalog");
  const price = page.getByTestId("catalog-row").filter({ hasText: SUGAR.nameAr }).getByTestId("catalog-row-price");
  await expect(price).toContainText("١٬٢٥٠"); // Arabic interface: Arabic-Indic digits
  await expect(price).not.toContainText("1,250");

  await context.addCookies([{ name: "rt_locale", value: "en", url: new URL(page.url()).origin }]);
  await page.goto("/retail/catalog");
  const priceEn = page.getByTestId("catalog-row").filter({ hasText: SUGAR.nameAr }).getByTestId("catalog-row-price");
  await expect(priceEn).toContainText("1,250");
  await expect(priceEn).not.toContainText("١");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(en.catalog.title);
});
