# Sales screen v3 (touch till): report

Branch `retail-till-v3` (from main 488ff88). UI only: no sale logic, no service, no Prisma change.

## What changed

The first v3 pass (dark bar, picture cards, big controls) was rejected by the owner as too loud and too big. This is the third direction: calm, text first, small.

- **App frame.** A slim light rail of shop sections at the side from 768px up (a list inside the Options drawer on phones): Sell (open), Shift and cash, Stock, Items, Shop setup link to existing screens; Expenses, Suppliers, Customers and credit, Reports are disabled and say "soon" (no fake data). Words come from the message files in ar, ckb, en.
- **Tiles.** Text only: name (14px), price (15px bold) and a 3px bar in the category colour. No photo area, no big letters. A small round badge shows how many are in the cart. 68px tall, about 124px wide.
- **Type scale.** 12 / 13 / 14 / 15px everywhere in the till; the only large number is the total (up to 32px, shrinks to fit any length). Pay is 18px.
- **Chips.** One row of small chips (36px), one accent colour for the chosen one; the category colour is only a small dot.
- **Cart.** Rows with a 36px stepper (tap area grows to 44px through padding), line total 15px, no heavy borders. Hold and Clear moved into one three-dot menu in the cart header (new key `till.cartActions`); the cart footer is now: total, Pay.
- **Less decoration.** No dark total box, no amber, no dark rail, no 3D button edges, no shadows except one on the popover and the dialogs. One accent (the shop's teal) plus green for Pay and money received.
- **Payment panel.** Light, same scale. Quick cash (exact first), keypad, change due (soft green) or still due (soft amber), green Complete sale.
- **States.** Empty cart, no match, skeleton tiles while a category loads, offline strip (cart is kept), error notice, loading page shaped like the till.

## Files

`src/app/retail/sell/sell.css`, `sell-screen.tsx`, `till-nav.tsx` (new), `_lib/views.tsx`, `_lib/till.ts` (`textLength` only added), `_lib/nav-icons.tsx` (new), `loading.tsx`, `src/messages/{ar,ckb,en}.ts`, `tests/ui/sell-ui.test.ts`.

## Screenshots (real Chrome, full resolution, `docs/superpowers/reports/assets/`)

till-v3-desktop-ar, desktop-en, desktop-empty-ar, desktop-menu-en (the three-dot menu open), desktop-pay-en, desktop-change-en, desktop-nomatch-ar, landscape-ar (1024x768), tablet-ar, tablet-en (768x1024), phone-grid-ar, phone-grid-en, phone-cart-ar, phone-cart-en, phone-empty-cart-en, phone-pay-ar, phone-offline-ar (all 375x812). Data: the 30-item sample plus about 2,000 generated items and worst-case rows (a name with no break, a price of 9,999,999,999). The small round "N" at the bottom corner is the Next.js dev indicator, not the app.

## Judgement

It now reads as clean, not crowded: on desktop the screen has one search box, one chip row, the grid, and a cart with a total and one button. Compared with the references (58, 59, 60) it is as dense in products but with fewer controls and lighter lines. I have not shown it to the owner; this is my own reading of the screenshots.

## Verified

- `npx tsc --noEmit`: no errors.
- `eslint src/app/retail/sell tests/ui/sell-ui.test.ts src/messages`: no findings.
- `vitest run tests/ui tests/sales tests/messages` on an embedded Postgres (own port): 202 passed, 3 failed on the first run, all three in `tests/sales/sales.test.ts` with "timed out in 5000ms" (the machine was busy with the dev server). Re-running that file with `--testTimeout=30000`: 20 of 20 passed. The word guard and message parity tests (tests/messages) passed. I did not run the whole suite or the Playwright e2e specs.
- Looked at live in Chrome: desktop, 1024x768, 768x1024, 375x812 in Arabic and English; pay panel with change; offline strip; no-match; empty cart; the three-dot menu.
- Earlier in this task (before the calm pass): 2,037 items, tap response and DOM size measured in dev mode (78 to 166 ms per tap with 2,000 tiles against about 20 ms with 60). Not re-measured after the calm pass.

## Not verified / still weak

- The Kurdish (ckb) screen was not looked at, only its key parity is tested.
- A real touch device, a barcode scanner and a printer were not used (emulated touch only).
- Dev-mode speed with 2,000 tiles is above 100 ms; tiles use content-visibility, a production build was not measured.
- Hold and Clear are one tap each inside the menu; Clear has no second confirmation any more (the old double-tap guard was on the removed button). Held carts are still listed in Options.
- No discount, price override or notes exist in the app, so none appear; the menu holds only Hold and Clear.
- A line total of 9,999,999,999 is cut with an ellipsis on a narrow cart (about 1024px); the full figure is in the unit-price line and the footer total.
- Quick cash offers only amounts at or above what is due.
- The offline strip follows the browser's online flag only (no real request check).
- English names fall back to the Arabic name when no English one exists.
- 21st-ui-review CLI is not installed here; the review and the break-ui pass were done by hand against the screenshots and the worst-case rows.
- Swipe to delete a cart line is not built.

## Photo feature (not built)

A real product-photo feature would need: an upload control in the item editor; object storage (a bucket or the VPS disk) with a per-business folder; resizing on upload (for example 320px wide, WebP, 20 to 40 KB) so 2,000 tiles stay light; a nullable image path on the item (a schema change, which this task did not allow); lazy-loaded images in tiles; and a text fallback when there is none, as now. Photos are left out on purpose: the owner asked for text-first tiles.
