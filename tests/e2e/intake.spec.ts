import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { ar } from "../../src/messages/ar";
import { ADMIN, BUSINESS, INTAKE_FAKE_FILE, INTAKE_ITEM, OWNER, PASSWORD } from "./fixtures";

/*
 * R1b end to end: the owner photographs a supplier's receipt (here: uploads a fixed image), the
 * fake provider (INTAKE_PROVIDER=fake on the e2e dev server, answer from INTAKE_FAKE_FILE) reads it,
 * the owner settles it in Arabic at 375px, creates the draft, posts it on R2's receipt screen and
 * sees the stock. The platform admin turns the shop's AI switch on first and OFF again afterwards
 * (afterAll, also when a step fails), as later specs expect it off.
 */

const SCENARIO = JSON.parse(readFileSync(INTAKE_FAKE_FILE, "utf8")) as { lines: { description: string; quantity: string }[] };
const NEW_ITEM = SCENARIO.lines[1]!.description;

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/);
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

// ---------------------------------------------------------------------------------------------
// The shop's AI switch, through the platform admin's screen (as tests/e2e/admin-ai.spec.ts).

const aiRow = (page: Page) => page.getByTestId("business-table").locator("tr", { has: page.getByTitle(BUSINESS, { exact: true }) });

async function setSwitch(browser: Browser, baseURL: string | undefined, to: "on" | "off", reason: string) {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await signIn(page, ADMIN.email);
    await page.goto("/admin");
    const r = aiRow(page);
    const state = r.getByTestId("ai-state");
    await expect(state).toBeVisible();
    if ((await state.getAttribute("data-state")) === to) return;
    await r.getByTestId("ai-switch-toggle").click();
    const form = page.getByTestId("ai-form-row");
    await form.getByTestId("ai-switch-reason").fill(reason);
    await form.getByTestId("ai-switch-confirm").click();
    await expect(state).toHaveAttribute("data-state", to);
  } finally {
    await context.close();
  }
}

test.afterAll(async ({ browser }, testInfo) => {
  await setSwitch(browser, testInfo.project.use.baseURL, "off", "إعادة الحالة الافتراضية بعد الاختبار");
});

// ---------------------------------------------------------------------------------------------
// A fixed receipt image: a 240x320 PNG, white with dark "printed lines" (built here, so no binary in the repo).

function receiptPng(): Buffer {
  const width = 240;
  const height = 320;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3, 0xff);
    row[0] = 0; // filter: none
    const printed = y % 24 >= 8 && y % 24 < 14 && y > 20 && y < height - 20;
    if (printed) for (let x = 20; x < width - 20 - ((y * 7) % 60); x++) row.fill(0x30, 1 + x * 3, 4 + x * 3);
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------------------------

test("the owner reads a supplier's receipt from a photo at 375px in Arabic, settles it, posts the draft and sees the stock", async ({ page, browser }, testInfo) => {
  test.setTimeout(120_000);
  await setSwitch(browser, testInfo.project.use.baseURL, "on", "تجربة قراءة الوصولات بطلب المالك");

  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, OWNER.email);

  // The receipt screen offers the photo; the first time, the owner reads and accepts the consent.
  await page.goto("/retail/stock/receive");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("receipt-photo-link")).toHaveText(ar.stock.intake.fromPhoto);
  await page.getByTestId("receipt-photo-link").click();
  await expect(page).toHaveURL(/\/retail\/stock\/receive\/photo$/);
  const consent = page.getByTestId("intake-consent");
  await expect(consent.or(page.getByTestId("intake-capture"))).toBeVisible();
  if (await consent.isVisible()) {
    await expect(page.getByTestId("intake-consent-text")).toBeVisible();
    await page.getByTestId("intake-consent-grant").click();
  }
  await expect(page.getByTestId("intake-capture")).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);

  // Upload the page, then read it.
  await page.getByTestId("intake-upload").setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: receiptPng() });
  await expect(page.getByTestId("intake-page")).toHaveCount(1);
  await page.getByTestId("intake-read").click();
  await expect(page).toHaveURL(/\/retail\/stock\/receive\/photo\/[^/]+$/, { timeout: 30_000 });
  const review = page.getByTestId("intake-review");
  await expect(review).toBeVisible({ timeout: 45_000 });
  expect(await noHorizontalScroll(page)).toBe(true);
  await expect(page.getByTestId("intake-viewer-image")).toBeVisible();

  // Line 1: the known item by its barcode, matched. Line 2: an item the shop does not have yet.
  const lines = page.getByTestId("intake-line");
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toContainText(INTAKE_ITEM.nameAr);
  await expect(lines.nth(0).getByTestId("intake-line-badge")).toHaveAttribute("data-kind", "MATCHED");
  await expect(lines.nth(1)).toContainText(NEW_ITEM);
  await expect(lines.nth(1).getByTestId("intake-line-badge")).toHaveAttribute("data-kind", "UNKNOWN");
  await expect(page.getByTestId("intake-total")).toHaveAttribute("data-state", "ok");
  await expect(page.getByTestId("intake-draft")).toHaveAttribute("aria-disabled", "true");

  // Create the new item from the receipt line; every line is then settled.
  await page.getByTestId("intake-create-all").click();
  await expect(lines.nth(1).getByTestId("intake-line-badge")).toHaveAttribute("data-kind", "MATCHED");
  await expect(page.getByTestId("intake-open-count")).toHaveText(ar.stock.intake.review.allResolved);
  await expect(page.getByTestId("intake-draft")).not.toHaveAttribute("aria-disabled", "true");
  expect(await noHorizontalScroll(page)).toBe(true);

  // The draft opens on R2's receipt screen with both lines; posting it moves the stock.
  await page.getByTestId("intake-draft").click();
  await expect(page).toHaveURL(/\/retail\/stock\/receive\?draft=/, { timeout: 30_000 });
  await expect(page.getByTestId("receipt-form")).toHaveAttribute("data-kind", "RECEIPT");
  await expect(page.getByTestId("receipt-line")).toHaveCount(2);
  await expect(page.getByTestId("receipt-supplier")).toHaveValue(/شركة البركة للتجارة العامة/);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByTestId("receipt-post").click();
  await expect(page.getByTestId("receipt-done")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("receipt-done-lines")).toContainText("٢");
  // 6 x 1,750 + 4 x 2,250 = 19,500 IQD.
  await expect(page.getByTestId("receipt-done-total")).toContainText("١٩٬٥٠٠");

  // The stock: 6 pieces of the known item (10,500 for the owner), 4 bags of the new one.
  await page.goto(`/retail/stock?q=${INTAKE_ITEM.barcode}`);
  const known = page.getByTestId("stock-row").filter({ hasText: INTAKE_ITEM.nameAr });
  await expect(known).toHaveCount(1);
  await expect(known.getByTestId("stock-qty")).toHaveText(`٦ ${INTAKE_ITEM.piece}`);
  await expect(known.getByTestId("stock-value")).toContainText("١٠٬٥٠٠");
  await page.goto(`/retail/stock?q=${encodeURIComponent(NEW_ITEM)}`);
  const added = page.getByTestId("stock-row").filter({ hasText: NEW_ITEM });
  await expect(added).toHaveCount(1);
  await expect(added.getByTestId("stock-qty")).toHaveText("٤ كيس");
  expect(await noHorizontalScroll(page)).toBe(true);
});

test("without a camera, barcodes typed by hand: a new valid code is offered to the catalog, a known one opens its item", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, OWNER.email);
  await page.goto("/retail/catalog/scan");
  await expect(page.getByTestId("scan")).toBeVisible();
  const code = page.getByTestId("scan-code");

  // A valid EAN-13 the shop does not have: unknown, with the link and new-item actions (the AI switch is off here).
  await code.fill("6291041500220");
  await page.getByTestId("scan-find").click();
  const result = page.getByTestId("scan-result");
  await expect(result).toHaveAttribute("data-kind", "UNKNOWN", { timeout: 15_000 });
  await expect(result.getByTestId("scan-link")).toBeVisible();
  await expect(result.getByTestId("scan-create")).toBeVisible();
  await expect(result.getByTestId("scan-unverified")).toHaveCount(0);
  expect(await noHorizontalScroll(page)).toBe(true);

  // The known item's code (typed as a phone keyboard may: Arabic-Indic digits) opens the item.
  await code.fill(INTAKE_ITEM.barcode.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d))));
  await page.getByTestId("scan-find").click();
  await expect(page).toHaveURL(/\/retail\/catalog\/[^/?]+$/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1, name: INTAKE_ITEM.nameAr })).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
});
