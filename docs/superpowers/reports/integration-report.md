# Integration report: Retails (`retail-integration`)

Branch `retail-integration` in `.claude/worktrees/integration`, cut from `origin/main` 84b79da (after `git fetch`).
Local only: nothing pushed, no PR, nothing merged to main, nothing deployed. Its twin on the Studio side is
`retail-integration` in `C:\Users\pc\Documents\GitHub\buzzify-core-integration` (same report there).

## Merges

1. `retail-own-signin` (c8ab3f0). It was cut from 5b2c90b, before the till v2 (#9) reached main, so the merge is a
   real three-way merge onto the till v2. One conflict: `src/app/_ui/icons.tsx` (main added Menu, Close, Backspace,
   Drawer and Grid icons, the branch added Eye and EyeOff). Kept all of them.
2. `retail-packs` (a0acc79). One conflict: `src/app/login/page.tsx`. The own sign-in page (split layout, code and
   business steps, "Forgot your password?", the account-system link) is kept as it is, and it now names the product of
   the address it is on, as the packs card did: the `Wordmark` with `productBrand(pack, locale)` (the neutral
   "Buzzify Retails" on the shared address) and `packWords(pack, locale).loginTitle` as the heading on a product
   address. `auth-card.tsx` (now only `/admin/login`) and `src/server/core/handoff.ts` merged cleanly: `startHandoff`
   keeps the packs `appUrl` (the trusted current product origin), so the handoff starts and returns on the product
   address the browser is on, and the own sign-in's `HANDOFF_START_PATH` and `resetPasswordHref` are kept.

## Fixes made in the integration

| Commit | What |
| --- | --- |
| db2b905 | Gap 1. `coreStateSchema` takes an optional `activityType` (MARKET, ELECTRONICS, CLOTHING only, as Studio sends it). `applyCoreState` applies it under the same version gate as the other fields: a MIXED shop becomes MARKET, later changes follow Studio, an older or equal snapshot changes nothing, a snapshot without it keeps the stored type. Each change writes a `core.business.activity` audit row. A repeat provision with a newer snapshot moves an existing shop too. 5 new tests in `tests/core/state.test.ts`. |
| c0ec98e | Gap 4. The owner invitation mail names the shop's product (`packWords(getPack(activityType), "ar").productName`, e.g. "Buzzify ملابس") in the subject and the text, never "Buzzify Retails". Test in `tests/admin/invitations.test.ts`. |
| feb2c82, ee1f89b | Gap 2. `tests/e2e/core-handoff.spec.ts` and `tests/e2e/login.spec.ts` expect `/retail/sell` (or the workplace chooser), since a seller's home now redirects to the till. `shell.spec.ts` already expected `/retail/sell` after choosing a workplace; its header-height limit is raised for the packs wordmark line (see Playwright). |
| 1d71aaa | Semantic merge conflicts. The till v2's English `till.menu`, `closeMenu`, `shopMenu` ("Menu", "Close menu", "Shop menu") fail the own sign-in branch's word guard (`\bmenus?\b`, the restaurant product's word); now "Options", "Close options", "Shop options" (ar and ckb never used the word). `tests/ui/login-ui.test.ts` normalises CRLF when it reads `globals.css` (a Windows checkout with `core.autocrlf` failed the layout regex). `tests/messages/own-words.test.ts` imports `entries` from the shared helper (the packs guard used it, the own sign-in branch moved it). |

## Tests (my own embedded Postgres on port 54517, database `retails_int_test`)

- `tsc --noEmit`: clean. `eslint .`: clean.
- Vitest `tests/core tests/ui tests/messages tests/auth tests/admin tests/packs tests/setup tests/sales`, full run:
  514 tests, 505 passed, 9 failed. 2 were real (the till "Menu" words and the CRLF layout test, fixed in 1d71aaa).
  7 were 5 s/10 s timeouts while the machine was loaded (`tests/core/handoff.test.ts` 3, `tests/admin/directory.test.ts` 2,
  `tests/admin/invitations.test.ts` 2). Rerun of those files plus `tests/messages`, `login-ui` and `state`: 137 tests,
  135 passed, 2 timeouts in `handoff.test.ts`; `handoff.test.ts` rerun alone: 43 of 43 pass.
- Playwright (`E2E_PORT=3500`, database `retails_int_e2e`): see "Playwright" below.

## End-to-end, both integration apps together (first real run against each other)

Setup: one embedded Postgres 18 cluster of my own (scratchpad data dir, port 54517; databases `studio_int_live`,
`retails_int_live`). Studio integration `next dev` on 3300, Retails integration `next dev` on 3400. Random test
values for the three secret pairs and `CRON_SECRET` (never written to a repository). Env:

- Studio: `RETAIL_URL=http://localhost:3400`, `RETAIL_URL_SUPERMARKET=http://supermarket.localhost:3400`,
  `RETAIL_URL_ELECTRONICS=http://electronics.localhost:3400`, `BETTER_AUTH_URL=http://localhost:3300`,
  `RETAIL_SYNC_SECRET`, `RETAIL_CALLER_SECRET`, `RETAIL_HANDOFF_SECRET`, `CRON_SECRET`.
- Retails: `APP_URL=http://localhost:3400`,
  `PACK_HOSTS=supermarket.localhost=SUPERMARKET,electronics.localhost=ELECTRONICS`,
  `CORE_BASE_URL=http://localhost:3300`, `CORE_SYNC_SECRET`, `CORE_OUT_SECRET`, `CORE_HANDOFF_SECRET`.

The built-in browser resolved `*.localhost` directly; no proxy was needed.

| Step | Result |
| --- | --- |
| Studio: seeded Super Admin signs in, sets up 2FA (TOTP), creates "Int Market" under Supermarket with a branch and an owner email | OK |
| Studio: Retail plan "starter" made, priced and offered; trial started on the shop | OK |
| Owner accepts the Studio invitation (from the dev mail log), creates the account | OK; provisioning reached Retails right after (inline delivery): `RtBusiness` "Int Market", `activityType` MARKET, `coreStateVersion` 2 |
| (a) Retails own form on `supermarket.localhost` ("Sign in to Buzzify Supermarket"), email + password checked by Studio's `/api/retail/v1/credentials` | OK, then the workplace chooser, then the till (open shift) |
| (a) with 2FA: owner turns on 2FA in Studio; Retails' form asks for the code, refuses 000000 ("That code is not correct."), accepts the TOTP | OK |
| (b) Handoff: `supermarket.localhost:3400/api/core/v1/handoff/start` -> Studio `/api/retail/v1/handoff` with `return=http://supermarket.localhost:3400/...callback` -> callback -> `/retail/home` -> chooser -> `/retail/sell` | OK |
| (c) Till of the Supermarket pack: product "Rice 1kg" added, 20 received (stock document 1 posted), 2 sold for 5,000 IQD cash, receipt no. 1 | OK |
| Wrong product host: the Supermarket owner signs in on `electronics.localhost` (page "الدخول إلى Buzzify إلكترونيات") and is sent to `supermarket.localhost/retail/sell`; `electronics.localhost/retail/sell` with a session also lands on the Supermarket address | OK |
| Studio refuses foreign handoff returns: `evil.localhost`, a trailing slash, and the unconfigured `clothing.localhost` all get 400 | OK |
| Gap 1 live: the shop set to MIXED in Retails' DB, Studio's snapshot queued (outbox row due), `/api/cron/retail-sync` by hand: `{"sent":1}`, shop is MARKET at version 3 with the `core.business.activity` audit row | OK |

Screenshots: `assets/integration-1-supermarket-login.jpg` (375 px), `assets/integration-2-supermarket-sale.jpg`,
`assets/integration-3-electronics-address-sends-to-supermarket.jpg`.

### Playwright

`core-handoff.spec.ts`, `login.spec.ts` and `shell.spec.ts` (against the e2e fake Studio, port 3500, database
`retails_int_e2e`). First run: 17 passed, 2 failed, both from the merge:

- the handoff test landed on `/retail/select` (no branch chosen yet in that browser), as in the real run above;
  it now accepts `/retail/(sell|select)` like `login.spec.ts`;
- the 80-character business name at 375 px: the header is 140.3 px against a `< 140` limit, because the packs
  header adds the product wordmark line over the business name. The limit is now 150 with that reason in the test.

Second run: 19 of 19 pass. The other specs (catalog, import, intake, setup, stock, admin-ai) were not run.

## Problems found, not fixed here

1. **Studio after accepting a Retail invitation**: the new owner lands on Studio's
   `/studio/restaurants/<id>/menus` ("No menus yet. The menus you create for this restaurant are listed here.") and is
   not sent to Retails. `isRetailOnly` is false because the owner has an OWNER membership. A Retail owner sees
   restaurant and menu words in the Studio. Also the invitation mail says "You are invited to Buzzify Core".
   Studio side; needs a product decision.
2. **Password reset from Retails** returns to `RETAIL_URL/login` (the shared address), not the product address the
   person came from (`retailSignInUrl` in Studio's `entry.ts` has no product).
3. After signing out on a product address, the tab title once read "Buzzify Retails" until the next full load (the
   page itself named the product). Cosmetic.
4. The Studio dev log prints server action arguments, including the sign-in password, in development
   (`signIn({"email":...,"password":...})`). Development only, but worth knowing.
5. MIXED -> MARKET changes the type only; capabilities are not touched (the owner keeps what was provisioned).

## Not verified

- Clothing in the browser (no `RETAIL_URL_CLOTHING`/clothing pack host configured in this run).
- The Studio "Open Retails" button from a shop page (the handoff was started from Retails' start URL instead).
- The owner-of-several-shops chooser across products, and the Studio one-bounce redirect between product hosts in
  the browser (covered by Studio's `tests/retail/handoff-route.test.ts`).
- Production builds, Docker, Caddy, real TLS, `TRUSTED_PROXY_HOPS` on the VPS.
- The other Playwright specs (catalog, import, intake, setup, stock, admin-ai) were not run against the till home.

## Production deploy order and env

1. **Back up Studio's database** (Neon snapshot of `production`). Studio's Docker build runs `prisma migrate deploy`,
   which applies the additive `20261104100000_retail_activity` (new enum `RetailActivity`, new column
   `RetailLink.activity` NOT NULL DEFAULT 'SUPERMARKET'; existing shops such as "Rizgar" read as SUPERMARKET).
2. **Deploy Studio** (`retail-integration`): serves `/api/retail/v1/credentials*`, the three product spaces and the
   handoff allow-list. Env (all optional, an origin each, https, lowercase, no default port, needs `RETAIL_URL`):
   `RETAIL_URL_SUPERMARKET=https://supermarket.buzzify.tech`, `RETAIL_URL_ELECTRONICS=https://electronics.buzzify.tech`,
   `RETAIL_URL_CLOTHING=https://clothing.buzzify.tech`. `RETAIL_URL` stays the shared Retails address. No new secret.
   Studio must be first: until it serves `/credentials`, Retails' own form refuses every sign-in.
3. **Caddy on the VPS**: one site block `supermarket.buzzify.tech, electronics.buzzify.tech, clothing.buzzify.tech
   { encode zstd gzip; reverse_proxy <same upstream as the Retails block> }`, no Host rewrite, no `trusted_proxies`;
   `caddy validate` then `caddy reload` (`docs/deploy/vps-deploy.md`, "Product addresses").
4. **Deploy Retails** (`retail-integration`, no migration). Env:
   `PACK_HOSTS=supermarket.buzzify.tech=SUPERMARKET,electronics.buzzify.tech=ELECTRONICS,clothing.buzzify.tech=CLOTHING`
   (a malformed value stops the start), `TRUSTED_PROXY_HOPS=1` (Caddy alone in front; 2 only with a CDN in front of
   Caddy), `CORE_BASE_URL`, `CORE_SYNC_SECRET`, `CORE_OUT_SECRET`, `CORE_HANDOFF_SECRET` and `APP_URL` as today.
5. After both are up, the next reconcile pass resends every shop (the snapshot now has `activityType`, so its hash
   changed) and existing MIXED shops become MARKET/ELECTRONICS/CLOTHING. Run `/api/cron/retail-reconcile` by hand to
   do it at once, then check "Rizgar" in Retails' admin.
6. Checks: `curl -sI https://supermarket.buzzify.tech/login` is 200 and names Supermarket; sign in on the form and
   through Studio once each.
