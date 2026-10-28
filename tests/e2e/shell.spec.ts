import { expect, test, type Page } from "@playwright/test";
import {
  BRANCH_A,
  BRANCH_B,
  BUSINESS,
  CASHIER,
  LONG_BRANCH,
  LONG_BUSINESS,
  LONG_OWNER,
  PASSWORD,
  TERMINAL_A,
} from "./fixtures";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
}

test("a cashier of branch A sees only branch A on the select page", async ({ page }) => {
  await signIn(page, CASHIER.email);
  // No workplace chosen yet: home sends the cashier to the select page.
  await expect(page).toHaveURL(/\/retail\/select/);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  const branches = page.getByTestId("branch-option");
  await expect(branches).toHaveCount(1);
  await expect(page.getByTestId("branch-name")).toHaveText(BRANCH_A);
  await expect(page.getByText(BRANCH_B)).toHaveCount(0);
  // Branch A has a terminal: it is offered, with the no-terminal option.
  await expect(branches.getByRole("button", { name: TERMINAL_A })).toBeVisible();
});

test("the header shows business, branch, terminal and user", async ({ page }) => {
  await signIn(page, CASHIER.email);
  await expect(page).toHaveURL(/\/retail\/select/);
  await page.getByRole("button", { name: TERMINAL_A }).click();

  await expect(page).toHaveURL(/\/retail\/home/);
  await expect(page.getByTestId("header-business")).toHaveText(BUSINESS);
  await expect(page.getByTestId("header-branch")).toHaveText(BRANCH_A);
  await expect(page.getByTestId("header-terminal")).toHaveText(TERMINAL_A);
  await expect(page.getByTestId("header-user")).toHaveText(CASHIER.name);
  await expect(page.getByTestId("state-home-empty")).toBeVisible();
});

test("an 80-character business name does not overflow the header at 375px width", async ({ page }) => {
  expect(LONG_BUSINESS).toHaveLength(80);
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, LONG_OWNER.email);
  await expect(page).toHaveURL(/\/retail\/select/);
  // The long branch has no terminal: one button chooses it.
  await page.getByRole("button", { name: "العمل في هذا الفرع" }).click();
  await expect(page).toHaveURL(/\/retail\/home/);

  const name = page.getByTestId("header-business");
  await expect(name).toHaveText(LONG_BUSINESS);
  await expect(page.getByTestId("header-branch")).toHaveText(LONG_BRANCH);

  const layout = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('[data-testid="shell-header"]')!;
    const nameEl = document.querySelector<HTMLElement>('[data-testid="header-business"]')!;
    const branchEl = document.querySelector<HTMLElement>('[data-testid="header-branch"]')!;
    const inside = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.right <= window.innerWidth + 0.5;
    };
    return {
      pageScrollWidth: document.documentElement.scrollWidth,
      headerScrollWidth: header.scrollWidth,
      headerWidth: header.getBoundingClientRect().width,
      nameTruncated: nameEl.scrollWidth > nameEl.clientWidth,
      nameStyle: getComputedStyle(nameEl).textOverflow,
      branchTruncated: branchEl.scrollWidth > branchEl.clientWidth,
      everyHeaderPartInside: [...header.querySelectorAll("span, dd, dt, a, button, select")].every(inside),
      headerHeight: header.getBoundingClientRect().height,
    };
  });

  expect(layout.pageScrollWidth).toBeLessThanOrEqual(375);
  expect(layout.headerWidth).toBeLessThanOrEqual(375);
  expect(layout.headerScrollWidth).toBeLessThanOrEqual(375);
  expect(layout.nameTruncated).toBe(true);
  expect(layout.nameStyle).toBe("ellipsis");
  expect(layout.branchTruncated).toBe(true);
  expect(layout.everyHeaderPartInside).toBe(true);
  // Still a compact two-row bar, not a wrapped wall of text.
  expect(layout.headerHeight).toBeLessThan(140);
  await expect(page.getByRole("button", { name: "تسجيل الخروج" })).toBeInViewport();
});

test("switching the language to English turns the page left-to-right", async ({ page }) => {
  await signIn(page, CASHIER.email);
  await expect(page).toHaveURL(/\/retail\/select/);
  await page.getByTestId("locale-switcher").selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Choose where you work");
  await page.getByTestId("locale-switcher").selectOption("ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
});
