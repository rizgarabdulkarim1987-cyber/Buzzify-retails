import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { ar } from "../../src/messages/ar";
import { CASHIER, MANAGER, OWNER, PASSWORD, SUGAR } from "./fixtures";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/retail\//);
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** An Arabic CSV as Excel saves it (UTF-8 with BOM, CRLF). */
const csv = (lines: string[]) => Buffer.from(`﻿${lines.join("\r\n")}\r\n`, "utf8");

const JUICE = { code: "0099100000011", name: "عصير برتقال طبيعي" };
const BISCUIT = { code: "0099100000028", name: "بسكويت بالتمر" };

test("the owner uploads a CSV with errors, sees the preview, fixes nothing, commits the valid rows and downloads the rejected ones", async ({ page }) => {
  await signIn(page, OWNER.email);
  await page.goto("/retail/catalog");
  await page.getByTestId("catalog-import").click();
  await expect(page).toHaveURL(/\/retail\/catalog\/import$/);
  await expect(page.getByText(ar.catalog.import.barcodeTip)).toBeVisible();

  const file = csv([
    "الباركود,الاسم,السعر",
    `${JUICE.code},${JUICE.name},1500`, // 1 OK, the leading zeros are kept
    `${BISCUIT.code},${BISCUIT.name},750`, // 2 OK
    `${BISCUIT.code},بسكويت مكرر,800`, // 3 REJECTED: the barcode repeats row 2
    "0099100000035,=1+2,abc", // 4 REJECTED: bad price; the name is a formula
    ",صنف بلا باركود,500", // 5 REJECTED: no barcode and no SKU
    `${SUGAR.barcode},${SUGAR.nameAr},99999`, // 6 CHANGED: the seeded sugar with another price
  ]);
  await page.getByTestId("import-file").setInputFiles({ name: "أصناف.csv", mimeType: "text/csv", buffer: file });
  await page.getByTestId("import-upload-submit").click();

  // The wizard: the columns were recognised from the Arabic headers.
  await expect(page).toHaveURL(/\/retail\/catalog\/import\/[A-Za-z0-9_-]+/);
  await expect(page.getByTestId("import-wizard")).toHaveAttribute("data-status", "STAGED");
  await expect(page.getByTestId("import-map-barcode")).toHaveValue("0");
  await expect(page.getByTestId("import-map-name")).toHaveValue("1");
  await expect(page.getByTestId("import-map-price")).toHaveValue("2");
  await page.getByTestId("import-validate").click();

  // The preview: every row with its status and reason.
  await expect(page.getByTestId("import-wizard")).toHaveAttribute("data-status", "VALIDATED");
  await expect(page.getByTestId("import-count-total")).toContainText("٦");
  await expect(page.getByTestId("import-count-ok")).toContainText("٢");
  await expect(page.getByTestId("import-count-changed")).toContainText("١");
  await expect(page.getByTestId("import-count-rejected")).toContainText("٣");
  const row = (n: number) => page.locator(`[data-testid="import-row"][data-row="${n}"]`);
  await expect(row(1)).toHaveAttribute("data-status", "OK");
  await expect(row(1)).toContainText(JUICE.code); // with its zeros
  await expect(row(2)).toHaveAttribute("data-status", "OK");
  await expect(row(3)).toHaveAttribute("data-status", "REJECTED");
  await expect(row(3).getByTestId("import-row-reason")).toHaveText(ar.catalog.import.reasons.DUPLICATE_IN_FILE);
  await expect(row(4)).toHaveAttribute("data-status", "REJECTED");
  await expect(row(4).getByTestId("import-row-reason")).toHaveText(ar.catalog.import.reasons.BAD_PRICE);
  await expect(row(5).getByTestId("import-row-reason")).toHaveText(ar.catalog.import.reasons.MISSING_IDENTIFIER);
  await expect(row(6)).toHaveAttribute("data-status", "CHANGED");
  await expect(row(6).getByTestId("import-row-details")).toContainText("٩٩٬٩٩٩");
  // Filters show one status at a time.
  await page.getByTestId("import-filter-REJECTED").click();
  await expect(page.getByTestId("import-row")).toHaveCount(3);
  await page.getByTestId("import-filter-ALL").click();
  await expect(page.getByTestId("import-row")).toHaveCount(6);

  // Fixes nothing: the changed row keeps the default (skip), and the valid rows are saved.
  await expect(row(6).getByTestId("import-row-choice")).toHaveValue("SKIP");
  await page.getByTestId("import-commit").click();
  await expect(page.getByTestId("import-wizard")).toHaveAttribute("data-status", "COMMITTED", { timeout: 30_000 });
  await expect(page.getByTestId("import-stat-created")).toContainText("٢");
  await expect(page.getByTestId("import-stat-skipped")).toContainText("١");
  await expect(page.getByTestId("import-stat-rejected")).toContainText("٣");
  // Committed: the file can no longer be deleted.
  await expect(page.getByTestId("import-delete")).toHaveCount(0);

  // The rejected rows file: UTF-8 with BOM, the file's columns plus the reason, formulas neutralised.
  const downloading = page.waitForEvent("download");
  await page.getByTestId("import-download-rejected").click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/-rejected\.csv$/);
  const bytes = await readFile((await download.path())!);
  const text = bytes.toString("utf8");
  expect(text.charCodeAt(0)).toBe(0xfeff);
  const lines = text.slice(1).trim().split(/\r\n/);
  expect(lines[0]).toBe("الباركود,الاسم,السعر,reason");
  expect(lines).toHaveLength(4);
  expect(lines).toContain(`${BISCUIT.code},بسكويت مكرر,800,DUPLICATE_IN_FILE`);
  expect(lines).toContain("0099100000035,'=1+2,abc,BAD_PRICE");
  expect(lines).toContain(",صنف بلا باركود,500,MISSING_IDENTIFIER");
  expect(lines.some((l) => l.split(",").some((c) => c.startsWith("=")))).toBe(false);

  // The catalog has the valid rows only: the juice found by its barcode with the zeros, one biscuit.
  await page.goto("/retail/catalog");
  await page.getByTestId("catalog-search").fill(JUICE.code);
  await expect(page.getByTestId("catalog-row")).toHaveCount(1);
  await expect(page.getByTestId("catalog-row")).toContainText(JUICE.name);
  await page.getByTestId("catalog-search").fill("بسكويت");
  await expect(page.getByTestId("catalog-row")).toHaveCount(1);
  await expect(page.getByTestId("catalog-row")).toContainText(BISCUIT.name);
  // The skipped change left the sugar's price alone.
  await page.getByTestId("catalog-search").fill(SUGAR.barcode);
  await expect(page.getByTestId("catalog-row-price")).not.toContainText("٩٩٬٩٩٩");

  // The batch is listed with its saved rows.
  await page.goto("/retail/catalog/import");
  await expect(page.getByTestId("import-batch").first()).toContainText("أصناف.csv");
  await expect(page.getByTestId("import-batch").first()).toContainText(ar.catalog.import.batchStatus.COMMITTED);
});

test("a manager can open the import; a cashier cannot reach it", async ({ page }) => {
  await signIn(page, MANAGER.email);
  await page.goto("/retail/catalog/import");
  await expect(page.getByTestId("import-upload")).toBeVisible();
  await page.context().clearCookies();

  await signIn(page, CASHIER.email);
  await page.goto("/retail/catalog");
  await expect(page.getByTestId("catalog-import")).toHaveCount(0);
  await page.goto("/retail/catalog/import");
  await expect(page.getByTestId("state-forbidden")).toBeVisible();
  await expect(page.getByTestId("import-upload")).toHaveCount(0);
});

test("the import wizard holds at 375px in Arabic", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, OWNER.email);
  await page.goto("/retail/catalog/import");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByTestId("import-file").setInputFiles({
    name: "ضيق.csv",
    mimeType: "text/csv",
    buffer: csv(["الباركود,الاسم,السعر", "0099200000010,منتج باسم طويل جداً لاختبار الالتفاف في الشاشة الضيقة,1000", "0099200000010,مكرر,1"]),
  });
  await page.getByTestId("import-upload-submit").click();
  await expect(page.getByTestId("import-wizard")).toHaveAttribute("data-status", "STAGED");
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByTestId("import-validate").click();
  await expect(page.getByTestId("import-wizard")).toHaveAttribute("data-status", "VALIDATED");
  await expect(page.getByTestId("import-row")).toHaveCount(2);
  expect(await noHorizontalScroll(page)).toBe(true);
  // Nothing saved: the batch can be deleted.
  await page.getByTestId("import-delete").click();
  await page.getByTestId("import-delete-yes").click();
  await expect(page).toHaveURL(/\/retail\/catalog\/import$/);
});
