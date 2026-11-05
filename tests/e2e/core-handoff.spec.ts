import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { ar } from "../../src/messages/ar";
import { signHandoffForTests } from "../../src/server/core/handoff";
import { ADMIN, CORE_SHOP, E2E_CORE_BASE_URL, E2E_HANDOFF_SECRET, E2E_PORT, PASSWORD } from "./fixtures";

/*
 * Sign in with Studio at 375px in Arabic. No real Studio: the browser's request to CORE_BASE_URL
 * (E2E_CORE_BASE_URL, set in playwright.config.ts) is intercepted with page.route. The callback
 * leg uses a token signed in the test with the app's own signing helper and the dev server's
 * CORE_HANDOFF_SECRET, bound to the nonce the app sent (what Studio must echo).
 */

/**
 * Chromium does not route the target of a server redirect, so the browser could never be stopped at
 * Studio. Instead /start is answered by the real app (route.fetch, redirects not followed): its
 * Location is Studio's handoff URL, which is what is asserted, and the browser is sent on to
 * wherever `studio` decides (the callback, or back to the login page), keeping the app's Set-Cookie.
 */
async function fakeStudio(page: Page, studio: (handoffUrl: URL) => string): Promise<{ handoffUrl: () => URL | null }> {
  let seen: URL | null = null;
  await page.route("**/api/core/v1/handoff/start", async (route) => {
    const real = await route.fetch({ maxRedirects: 0 });
    seen = new URL(real.headers()["location"]!);
    await route.fulfill({ response: real, headers: { ...real.headers(), location: studio(seen) } });
  });
  return { handoffUrl: () => seen };
}

function tokenFor(nonce: string) {
  const iat = Math.floor(Date.now() / 1000);
  return signHandoffForTests(
    {
      aud: "retail",
      iat,
      exp: iat + 60,
      nonce,
      jti: randomUUID(),
      coreUserId: CORE_SHOP.owner.coreUserId,
      email: CORE_SHOP.owner.email,
      emailVerified: true,
      name: CORE_SHOP.owner.name,
      coreBusinessId: CORE_SHOP.coreBusinessId,
    },
    E2E_HANDOFF_SECRET,
  );
}

/** What Studio does: sends the browser back to the app's callback with a token and the same state. */
function backToApp(q: URLSearchParams, nonce: string): string {
  const back = new URL(q.get("return")!);
  back.searchParams.set("token", tokenFor(nonce));
  back.searchParams.set("state", q.get("state")!);
  return back.toString();
}

const CALLBACK = `http://localhost:${E2E_PORT}/api/core/v1/handoff/callback`;

async function arabicPhone(page: Page) {
  await page.context().addCookies([{ name: "rt_locale", value: "ar", url: test.info().project.use.baseURL! }]);
  await page.setViewportSize({ width: 375, height: 812 });
}

// The browser handoff still starts at /api/core/v1/handoff/start (Studio's "Open Retails" goes there);
// /login itself is Retails' own form (tests/e2e/login.spec.ts).
const START = "/api/core/v1/handoff/start";

test("the handoff start sends the browser to Studio's handoff with state and nonce", async ({ page }) => {
  await arabicPhone(page);
  const studio = await fakeStudio(page, () => `http://localhost:${E2E_PORT}/login?stopped=studio`);

  await page.goto(START);
  await expect(page).toHaveURL(/stopped=studio/);

  const url = studio.handoffUrl()!;
  expect(url.origin).toBe(E2E_CORE_BASE_URL);
  expect(url.pathname).toBe("/api/retail/v1/handoff");
  const q = url.searchParams;
  expect(q.get("return")).toBe(CALLBACK);
  expect(q.get("state")).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  expect(q.get("nonce")).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  expect(q.get("nonce")).not.toBe(q.get("state"));
  // The state cookie is HttpOnly and scoped to the handoff routes only.
  const c = (await page.context().cookies()).find((x) => x.name === "rt_core_handoff");
  expect(c?.httpOnly).toBe(true);
  expect(c?.path).toBe("/api/core/v1/handoff");
});

test("a Studio-signed token completes the sign-in and lands in the shop", async ({ page }) => {
  await arabicPhone(page);
  await fakeStudio(page, (url) => backToApp(url.searchParams, url.searchParams.get("nonce")!));

  await page.goto(START);
  // Whoever sells lands straight in the till (/retail/home sends them on to /retail/sell), or first in the
  // workplace chooser when no branch is chosen yet in this browser.
  await expect(page).toHaveURL(/\/retail\/(sell|select)/);
  await expect(page.getByText(CORE_SHOP.name).first()).toBeVisible();
  // The shop page may settle (a refresh after the workplace is chosen) before it can be measured.
  await page.waitForLoadState("networkidle");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a token that is not bound to this browser's handoff is refused", async ({ page }) => {
  await arabicPhone(page);
  await fakeStudio(page, (url) => backToApp(url.searchParams, "some-other-browsers-nonce"));
  await page.goto(START);
  await expect(page).toHaveURL(/\/login\?error=core/);
  await expect(page.getByText(ar.auth.coreFailed)).toBeVisible();
});

test("the platform admin sees a linked shop's notice and a switch that cannot be changed here (375px)", async ({ page }) => {
  await arabicPhone(page);
  await page.goto("/admin/login");
  await page.locator('input[name="email"]').fill(ADMIN.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/admin");

  const row = page.getByTestId("business-table").locator("tr", { has: page.getByTitle(CORE_SHOP.name, { exact: true }) });
  await expect(row.getByTestId("core-linked-badge")).toHaveText(ar.adminCore.badge);
  await expect(row.getByTestId("core-linked-notice")).toContainText(ar.adminCore.notice);
  const toggle = row.getByTestId("ai-switch-toggle");
  await expect(toggle).toHaveAttribute("aria-disabled", "true");
  // aria-disabled (not the disabled attribute), so Playwright's click waits for ever: dispatch the click itself; nothing may open.
  await toggle.dispatchEvent("click");
  await expect(page.getByTestId("ai-form-row")).toHaveCount(0);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
