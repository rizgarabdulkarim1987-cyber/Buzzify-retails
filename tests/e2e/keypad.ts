import { expect, type Page } from "@playwright/test";

/**
 * Types digits into the till's active amount, safe on a page that has not finished hydrating.
 *
 * A key typed before hydration does nothing (CI's cold dev server hydrates late), so the first digits get lost and
 * the amount comes out short. The first digit is pressed on the keypad until the display changes (never twice), then
 * the rest is typed. The first digit must not be 0 (it would not change an empty amount).
 */
export async function typeDigitsWhenReady(page: Page, displayTestId: string, digits: string) {
  if (!/^[1-9]\d*$/.test(digits)) throw new Error("typeDigitsWhenReady: digits must start with 1-9");
  const display = page.getByTestId(displayTestId);
  const before = (await display.textContent()) ?? "";
  await expect(async () => {
    if (((await display.textContent()) ?? "") === before) await page.getByTestId(`key-${digits[0]}`).click();
    await expect(display).not.toHaveText(before, { timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  if (digits.length > 1) await page.keyboard.type(digits.slice(1));
}
