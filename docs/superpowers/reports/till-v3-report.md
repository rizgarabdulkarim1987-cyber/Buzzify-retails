# Sales screen v3 (touch till): report

Branch `retail-till-v3`. UI only: no sale logic, no service, no Prisma change.

History: pass 1 (dark bar, picture cards) and pass 2 (calm, small, cart on the side) were both rejected by the owner. The owner's point: the ticket is where most work happens, so it must be the largest area, in the layout used by Odoo POS, Square and Lightspeed. This is pass 3.

## Layout (what is built)

- **Ticket = the big panel**, about 52 to 57% of the width, full height. Receipt-style table: Item (two lines allowed), Qty, Price, Total (the Price column appears when the ticket is wider than 30rem; below that the unit price sits under the name). Rows are 56px (52px on short screens), 15px type. The selected line is tinted with an accent bar on its start edge (no layout shift). The list scrolls on its own and keeps the touched line in view. Empty state: icon plus a hint.
- **Total block** under the lines: "Total", the item count and the total in large type (it shrinks to fit any length). The app has no discount and no tax, so no such rows are shown.
- **Keypad under the ticket**, always there: a 4 x 4 grid, 56px keys (44px on short screens): `7 8 9 Qty / 4 5 6 + / 1 2 3 - / 0 . back C`. It edits the selected line: digits type the new quantity (shown at once in the row), `.` only for weighed items, `+` and `-` add or take one, backspace, C starts the entry over. **Qty is the only mode**: the app has no price override and no discount, so no Price or Disc keys (no dead keys).
- **Function keys** beside the keypad: Hold, Void line, Clear (asks twice within 3 seconds), Customer and Note (disabled, marked "soon").
- **Big green PAY** across the keypad width. It opens the full payment panel: Cash first (active) and Card, quick-cash chips (exact first), keypad, "Change" large in soft green or "Still due" in soft amber, Complete sale.
- **Products side** (about 43 to 48%): search and scan field on top, department chips, a grid of compact text tiles (name and price). All tiles share one neutral style; the department is shown only by the chip filter; a small round badge shows how many of the item are in the ticket.
- **Rail**: the slim module rail stays (Sell open; Shift and cash, Stock, Items, Shop setup link to existing screens; Expenses, Suppliers, Customers and credit, Reports are disabled and marked "soon").
- **Narrow** (below 48rem, phones): the ticket is the whole screen. A "Products" button opens the products as a full sheet with a bar to go back (count and total). The keypad folds away (a "Show keypad" bar); the function keys stay in one row. **Tablet portrait** (768 wide): rail, ticket and products side by side, the ticket slightly wider; its function keys sit in a row above the keypad. **Tablet landscape and desktop**: as described above.
- RTL: grid flow puts the rail and the ticket on the right and the products on the left in Arabic and Sorani; English mirrors. Logical properties only.
- Motion: row flash, badge pop, sheet fade, all short and off under reduced motion.
- Words: all from the ar, ckb, en message files; new keys under `till` (`ticket`, `colItem`, `colQty`, `colPrice`, `fnHold`, `fnVoid`, `fnClear`, `fnCustomer`, `fnNote`, `productsTab`, `backToTicket`, `padShow`, `padHide`, `methods`). Word guard and key-parity tests pass.

## Screenshots (`docs/superpowers/reports/assets/till-v3-*.png`, real Chrome, full resolution)

Data: 45 realistic supermarket items (milk, rice, tea, sugar, oil, water, biscuits, cheese, bread and so on, 250 to 11,500 IQD) in 8 departments; the ticket has 6 lines (rice, milk x2, tea, sugar x3, oil, water x6), total 29,250 IQD. The Next.js dev badge is hidden in the shots.

- Normal: desktop-ar, desktop-en, desktop-empty-ar, desktop-15lines-ar (1380x900); landscape-ar, landscape-en (1024x768); tablet-ar, tablet-en, tablet-15lines-ar (768x1024); phone-ticket-ar, phone-ticket-en, phone-padopen-ar, phone-products-ar, phone-products-en, phone-pay-ar, phone-empty-en, phone-offline-ar (390x844); desktop-pay-en, desktop-change-ar (payment panel, with change), desktop-nomatch-ar.
- Stress (kept apart): desktop-stress-ar and phone-stress-ar (an unbreakable 80-character name, a very long Arabic name, a 9,999,999,999 price, total 10,000,131,499).

I opened every one of these and fixed what I found: pay methods row unstyled, out-of-stock flag overlapping the price, qty and mode keys losing their style to a later rule, keypad open by default on a phone eating the ticket, loose Clear button in the payment panel.

## Judgement

Against the Odoo-style standard it now has the same structure: big ticket with a table, totals, keypad with function keys and a large Pay under it, products on the other side with search and chips, separate payment screen. Against references 58, 59 and 60 it is comparable in order and density; the ticket is clearly the largest area. Things that are plainer than Odoo: no customer or note (disabled), no price or discount mode (the app has none), no per-line delete swipe, product names in English fall back to Arabic. This is my own reading; the owner has not seen it yet.

## Checks

- `tsc --noEmit`: clean. `eslint` on `src/app/retail/sell`, `tests/ui/sell-ui.test.ts`, `src/messages`: clean.
- `vitest run tests/ui tests/messages`: 12 files, 184 tests passed (new tests: ticket row, ticket keypad, neutral tile, key parity for the new words).
- `vitest run tests/sales` (embedded Postgres, own port): 20 of 20 passed with a 30 s timeout. With the default 5 s timeout three DB-heavy tests timed out earlier while the dev server was busy; they are not UI tests.
- Not run: the whole suite and the Playwright e2e specs.

## Not verified / weak

- Kurdish (ckb) was not looked at; only parity is tested.
- No real touch device, barcode scanner or printer.
- The keypad is on screen only; a hardware keyboard types into the search box (scanner behaviour kept), not into the quantity.
- Backspacing a quantity to empty keeps the old quantity until a digit is typed (use Void line to remove).
- The line total column cuts a very large amount with an ellipsis (stress shots); the full figure is in the unit price and the total block.
- Quick cash offers amounts at or above what is due. The offline strip follows the browser's online flag only.
- Dev-mode speed with thousands of tiles was measured only in the first pass (78 to 166 ms per tap with 2,000 tiles); this pass was checked with 45 items, and not in a production build.
- Two items in the sample show "out" because their opening stock is zero in this local data.

## Photo feature (not built)

A real product-photo feature would need an upload control in the item editor, object storage per business, resizing on upload (for example 320px wide WebP, 20 to 40 KB), a nullable image path on the item (a schema change, not allowed here), lazy-loaded images in the tiles and a text fallback as now. Left out on purpose: the owner asked for text-first tiles.
