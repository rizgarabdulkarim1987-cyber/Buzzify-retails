import { expect, test } from "@playwright/test";
import { ar } from "../../src/messages/ar";
import { CASHIER, OWNER, PASSWORD } from "./fixtures";

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/retail\//);
}

test("the owner completes setup step 1 and sees it DONE after a reload", async ({ page }) => {
  await signIn(page, OWNER.email);
  await page.goto("/retail/setup");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  const step1 = page.getByTestId("setup-step-1");
  await expect(step1).toHaveAttribute("data-status", "PENDING");
  // The "soon" steps show no form.
  await expect(page.getByTestId("setup-step-4")).toHaveAttribute("data-status", "SOON");
  await expect(page.getByTestId("setup-form-4")).toHaveCount(0);

  // Saved with the values already there (the business name is shared with other specs).
  await step1.getByRole("button", { name: ar.setup.save }).click();
  await expect(step1.getByRole("status")).toHaveText(ar.setup.saved);

  await page.reload();
  await expect(page.getByTestId("setup-step-1")).toHaveAttribute("data-status", "DONE");
  await expect(page.getByTestId("setup-status-1")).toHaveText(ar.setup.statusLabels.DONE);
  await expect(page.getByTestId("setup-step-6")).toHaveAttribute("data-status", "SOON");
});

test("a cashier gets the no-permission state on the setup page", async ({ page }) => {
  await signIn(page, CASHIER.email);
  await page.goto("/retail/setup");
  await expect(page.getByTestId("state-forbidden")).toBeVisible();
  await expect(page.getByTestId("setup-step-1")).toHaveCount(0);
});
