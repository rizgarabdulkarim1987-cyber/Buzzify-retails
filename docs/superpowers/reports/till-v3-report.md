# Sales screen v3 (touch till): report

Branch `retail-till-v3`. UI only: no sale logic, no service, no Prisma change.

History: pass 1 (dark bar, picture cards) and pass 2 (calm, small, cart on the side) were both rejected by the owner. The owner's point: the ticket is where most work happens, so it must be the largest area, in the layout used by Odoo POS, Square and Lightspeed. This is pass 3.

## Layout (what is built)

- **Ticket = the big panel**, about 52 to 57% of the width, full height. Receipt-style table: Item (two lines allowed), Qty, Price, Total (the Price column appears when the ticket is wider than 30rem; below that the unit price sits under the name). Rows are 56px (52px on short screens), 15px type. The selected line is tinted with an accent bar on its start edge (no layout shift). The list scrolls on its own and keeps the touched line in view. Empty state: icon plus a hint.
- **Total block** under the lines: "Total", the item count and the total in large type (it shrinks to fit any length). The app has no discount and no tax, so no such rows are shown.
- **Keypad under the ticket**, always there: a 4 x 4 grid, 56px keys (44px on short screens): `7 8 9 Qty / 4 5 6 + / 1 2 3 - / 0 . back C`. It edits the selected line: digits type the new quantity (shown at once in the row), `.` only for weighed items, `+` and `-` add or take one, backspace, C starts the entry over. **Qty is the only mode**: the app has no price override and no discount, so no Price or Disc keys (no dead keys).
- **Function keys** beside the keypad: Void line, Clear (asks twice within 3 seconds, closes the sale), Customer and Note (disabled, marked "soon"). "Hold" is gone: parallel sales (below) replace it.
- **Big green PAY** across the keypad width. It opens the full payment panel: Cash first (active) and Card, quick-cash chips (exact first), keypad, "Change" large in soft green or "Still due" in soft amber, Complete sale.
- **Barcode field** at the top of the ticket (full width, scan icon, always focused on desktop and tablet, not on a touch phone). One barcode hit goes straight into the ticket (the line flashes, the field clears); an unknown code shows a clear message.
- **Parallel sales** (the owner's "more than one customer at once"): a tab strip at the very top of the ticket, one tab per open sale ("Sale 1", item count and total), the active one filled, and a large "+ New sale" button that is always visible. On a narrow ticket (phone, tablet portrait) it is a compact switcher ("Sale 2 of 3") beside "+ New sale"; the switcher opens a list of the open sales with count and total. "+ New sale" keeps the current ticket and opens a blank one (nothing happens if the current one is empty). Tapping a tab switches without losing anything. Paying or clearing the active sale closes its tab and shows the most recently used other one (or a blank). A blank sale left behind when switching is dropped, so empties never pile up. At most 8 open sales; the 9th attempt shows a friendly message. They are stored in the same device store as the old held carts (localStorage key `till-held:<business>:<user>`, per business and per user), saved after every change, so a reload brings them back, with the last used one on screen. Carts held before this change appear as sales with numbers. **The sales are device-local: two tills do not see each other's sales** (no schema change, no server state). The payment panel is a full-screen layer over the active sale only, so it cannot show another one; the idempotency key is created per payment attempt for the sale on screen and dropped whenever its lines or the tender change, as before.
- **Products side** (about 43 to 48%): name search on top. It opens on **department cards only** (no products, no prices). Tap one: a breadcrumb ("All categories > Dairy" with a back button) and that department's compact text tiles; tapping a product adds it and stays in the department. Typing in the search shows matches across all departments; clearing returns to the cards. 15 lines, long names and 30+ departments scroll inside the area. The "All" card shows everything.
- **Department card** (the look of the buzzify.me card, no motion): near-black card (#05050f), 1px border and a soft still glow in one accent colour, 16px radius. Top: a 2px line glyph in the accent (one per department key, 23 plus "all" plus a generic tag for owner-made ones) and a two-digit index in mono ("00" for All). Then the name in large bold type (Space Grotesk for Latin names, the system Arabic font for Arabic and Sorani, tight tracking only for Latin so Arabic joins and diacritics stay intact), a dim line with the item count ("5 items"; the All card shows "Departments: 8"), and a mono small-caps "Open" label with an arrow that mirrors in right-to-left. Only the pressed state exists (brighter border and glow); no transform, no hover, no entrance, no transition. Accents are bright tones that read on the dark card; the standard departments have fixed accents (for example dairy is always the same blue), an owner-made category gets one of the 14 palette tones from a hash of its name, so it never changes. Only the cards are dark; the till stays light. The department of an owner-made category is guessed from the words of its name (ar, ckb, en) only to choose the glyph; otherwise a generic tag. Nothing is written to any database, the 23 standard departments are not seeded (a separate spec).
  - The item count needed one small read-only addition: `listSellCategories` now also returns `itemCount` (products in the department and its sub-departments, archived, test and serial items left out). No schema change, no sale logic; covered in `tests/sales`.
  - Fonts for the tiles only: Space Grotesk (600, 700) and Geist Mono (500) through `next/font/google`, Latin subset, display swap, in `_lib/tile-fonts.ts`. The whole-app font change comes as its own commit.
- **Rail**: the slim module rail stays (Sell open; Shift and cash, Stock, Items, Shop setup link to existing screens; Expenses, Suppliers, Customers and credit, Reports are disabled and marked "soon").
- **Narrow** (below 48rem, phones): the ticket is the whole screen. A "Products" button opens the products as a full sheet with a bar to go back (count and total). The keypad folds away (a "Show keypad" bar); the function keys stay in one row. **Tablet portrait** (768 wide): rail, ticket and products side by side, the ticket slightly wider; its function keys sit in a row above the keypad. **Tablet landscape and desktop**: as described above.
- RTL: grid flow puts the rail and the ticket on the right and the products on the left in Arabic and Sorani; English mirrors. Logical properties only.
- Motion: row flash, badge pop, sheet fade, all short and off under reduced motion. The department cards have none.
- Words: all from the ar, ckb, en message files; new keys under `till` (ticket and keypad words, `scanPlaceholder`, `scanLabel`, `scanNotFound`, `allCategories`, `newSale`, `saleNo`, `saleOf`, `saleEmpty`, `openSales`, `ticketsLimit`, `openCategory`, `departments`); `holdCart`, `heldCarts` and `fnHold` were removed. Word guard and key-parity tests pass. The Sorani texts are a first draft and need a native reader.

## Screenshots (`docs/superpowers/reports/assets/till-v3-*.png`, real Chrome, full resolution)

Data: 45 realistic supermarket items in 8 departments; the ticket has 4 to 6 lines. The Next.js dev badge is hidden. New in this pass:

- Department cards: desktop-cats-ar, desktop-cats-en, desktop-cats-ckb, tablet-cats-ar, phone-cats-ar, desktop-cats-empty-ar; with 37 departments (29 extra, long names): desktop-manycats-ar, phone-manycats-ar.
- Inside a department: desktop-incat-ar, desktop-incat-en, tablet-incat-ar, phone-incat-ar. Search: desktop-search-ar, tablet-search-ar, phone-search-ar.
- Barcode: desktop-scan-ar, desktop-scan-en, desktop-scan-miss-ar, tablet-scan-ar, phone-scan-ar.
- Parallel sales (3 open): desktop-sales-ar, desktop-sales-en, tablet-sales-ar, phone-sales-ar, phone-sales-sheet-ar (the list), desktop-sales-limit-ar (the limit message).
- Earlier shots (normal, pay, change, 15 lines, offline, stress) were re-taken with the new cards.

I opened them and fixed: phone sheet button hidden check in my script, tablet portrait showing one tall card per row (now two slimmer cards), skeleton height. A flow script (not committed) drove a real browser through: three sales, switching, reload, paying one (its tab closes), and the 8-sale limit; every check passed.

## Judgement

Against the Odoo-style standard it now has the same structure: big ticket with a table, totals, keypad with function keys and a large Pay under it, products on the other side with search and chips, separate payment screen. Against references 58, 59 and 60 it is comparable in order and density; the ticket is clearly the largest area. Things that are plainer than Odoo: no customer or note (disabled), no price or discount mode (the app has none), no per-line delete swipe, product names in English fall back to Arabic. This is my own reading; the owner has not seen it yet.

## Checks

- `tsc --noEmit`: clean. `eslint` on `src/app/retail/sell`, `src/server/sales`, `tests/ui`, `src/messages`: clean (one documented `set-state-in-effect` exception for the once-per-load read of the device store).
- `vitest run tests/ui tests/messages`: 13 files, 198 tests passed. New: parallel tickets (numbering, parking and switching, no write when nothing changed, close after pay picks the last used other, limit of 8, reload round trip, old held carts get numbers), accent contrast (every accent and the dim ink at 4.5:1 or better on the card), fixed accents per key, stable hash accent for owner-made categories, card markup, key to glyph coverage for the 23 keys.
- `vitest run tests/sales` (embedded Postgres, own port): 20 of 20 passed (30 s or more timeout), including the new `itemCount` assertion.
- Not run: the whole suite and the Playwright e2e specs.

## Not verified / weak

- Kurdish (ckb): the department cards and the till were looked at once (desktop-cats-ckb); the texts are a first draft.
- Parallel sales are device-local and live in localStorage: another browser tab on the same till shares them and the last write wins; a private window keeps them in memory only until the page is left. Switching sales while the payment panel is open is not possible by design.
- The department cards use `next/font/google`: the build needs network access to Google Fonts once (the files are then self-hosted). A department with 0 items shows "٠ مادة", where the Arabic zero looks like a dot.
- The glyphs are simple hand-drawn line icons; a few (meat, spices, cleaning) are approximate.
- No real touch device, barcode scanner or printer.
- The keypad is on screen only; a hardware keyboard types into the search box (scanner behaviour kept), not into the quantity.
- Backspacing a quantity to empty keeps the old quantity until a digit is typed (use Void line to remove).
- The line total column cuts a very large amount with an ellipsis (stress shots); the full figure is in the unit price and the total block.
- Quick cash offers amounts at or above what is due. The offline strip follows the browser's online flag only.
- Dev-mode speed with thousands of tiles was measured only in the first pass (78 to 166 ms per tap with 2,000 tiles); this pass was checked with 45 items, and not in a production build.
- Two items in the sample show "out" because their opening stock is zero in this local data.
