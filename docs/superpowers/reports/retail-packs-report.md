# Retail packs foundation: report

Branch `retail-packs` (from `origin/main` 84b79da). Spec: `docs/superpowers/specs/2026-11-04-retail-packs-design.md`.
Foundation only: no new business features, no "coming soon" wording.

## What was built

**Pack registry, `src/packs/`.**

- `types.ts`: `PackId` (SUPERMARKET, ELECTRONICS, CLOTHING), `PackManifest`, `NavSection`, `PackWords`.
- `<pack>/manifest.ts`: id, activityType (MARKET, ELECTRONICS, CLOTHING), hostKey, wordSet, home
  (`/retail/home`), nav (sell, catalog, stock in the bar; scan, setup under More) with the permission each
  section needs, and the default capabilities. A test keeps the capabilities identical to
  `defaultCapabilities()`, so provisioning and the pack agree: supermarket BATCH, WEIGHT, MULTI_UNIT, HOLDS;
  electronics SERIAL, WARRANTY; clothing VARIANTS, HOLDS.
- `<pack>/words.ts`: each pack's own words in ar, ckb and en: product name ("Buzzify Supermarket"), product
  word, login heading, and nav labels (the catalog is Products, Devices or Items).
- `index.ts`: `getPack(activityType)` (MIXED, BEAUTY, STATIONERY and unknown values give SUPERMARKET),
  `packById`, `packWords`, `visibleNav`.
- `brand.ts`: wordmark and title values. `shell-words.ts`: the neutral "Buzzify Retails" wordmark and the
  not-available page words.
- `placement.ts`: which businesses an address may show.
- All pack words live outside `src/messages/*`. No shared message file was changed.

**Hosts, `src/packs/hosts.ts`.**

- `PACK_HOSTS` is parsed strictly. Each host is a bare lowercase name with no scheme, port, path, trailing
  dot or wildcard; a host appears once; a pack has one host; APP_URL's host is not allowed as a pack host.
- A malformed value throws `PackHostsError`. `src/instrumentation.ts` turns that into a failed production
  start.
- `resolveHost(headers)` trusts only the `Host` header, and only when it matches a configured host.
  `X-Forwarded-Host` and `Forwarded` are never read. An unknown host falls back to APP_URL. Absolute URLs
  are built on APP_URL's scheme and port.
- Better Auth `trustedOrigins` = APP_URL plus the pack origins, read per request.
- `next.config.ts` gets `allowedDevOrigins: ["*.localhost"]` (dev server only).

**Shell.**

- `loadShell` (`src/app/retail/_shell.ts`) filters memberships to the host's product.
- When every business of the user belongs to another product, `requireShell` redirects to that product's
  address (`<origin>/retail/home`) if PACK_HOSTS has one, otherwise to `/unavailable`. That page names only
  this address's product and offers Sign out.
- On the shared address each business shows its own pack. Before a business is chosen there, the shell
  shows the neutral "Buzzify Retails".
- The header shows a small wordmark over the business name, and the bar sections come from the manifest
  (testids `nav-sell`, `nav-catalog`, `nav-stock` kept).
- The login card shows the product wordmark and heading on a product address.
- Page titles come from `generateMetadata` in the root layout (host) and the retail layout (business).
- `listMemberships` and `shell.options` now also return `activityType`.
- The setup wizard no longer offers a list of activity types, which named the other products. It shows the
  product read-only and posts the current value back.

**Handoff.**

- `/start` builds the callback on the trusted current origin. `startHandoff` takes an optional `appUrl`;
  without one it still uses APP_URL.
- The state cookie and the session cookie are host-only (no Domain), so each address keeps its own.
- The callback redirects to relative paths only, so it is unchanged.
- The provision snapshot already accepts activityType MARKET, ELECTRONICS and CLOTHING.

## Env vars

| Var | Side | Value |
| --- | --- | --- |
| `PACK_HOSTS` (optional) | Retails | `supermarket.buzzify.tech=SUPERMARKET,electronics.buzzify.tech=ELECTRONICS,clothing.buzzify.tech=CLOTHING` |
| `RETAIL_URL_SUPERMARKET`, `_ELECTRONICS`, `_CLOTHING` (optional) | Studio | `https://<pack host>` |

APP_URL is unchanged: it stays the shared address and serves every pack.

## Caddy (VPS)

```caddyfile
supermarket.buzzify.tech, electronics.buzzify.tech, clothing.buzzify.tech {
	encode zstd gzip
	reverse_proxy retail:3000   # same upstream as the existing Retails block
}
```

There must be no Host rewrite in this block. Details are in `docs/deploy/vps-deploy.md` ("Product
addresses") and `docs/deploy/hostinger.md` (section 7).

## Tests

- `tests/packs/registry.test.ts`, `tests/packs/hosts.test.ts`: the registry, the parsing, and Host and
  X-Forwarded-Host spoofing.
- `tests/core/handoff-hosts.test.ts`: the callback per host, spoofing, host-only cookies, a full round trip on
  a pack host, and the old single-host flow.
- `tests/ui/pack-shell-ui.test.ts`: header and login card per pack and locale.
- `tests/messages/own-words.test.ts` is extended: the packs never name each other or use each other's words,
  pack words carry no Studio, Core, restaurant, pharmacy or cashier wording, and the shared messages name no
  pack.

## Verification

**Static checks.** `tsc --noEmit` is clean. `eslint .` is clean.

**Vitest.** All runs used an isolated database, `retails_packs_test` on the embedded server.

- Full run of tests/ui, messages, core, auth, packs, app, framework, acceptance, setup and admin: 573 of
  585 tests passed.
- The 12 failures were all 5 s or 10 s timeouts while the machine was loaded, in
  `tests/core/signing.test.ts`, `tests/framework/gate.test.ts`, `tests/framework/scoped-db.test.ts` and
  `tests/setup/staff-core.test.ts`.
- Rerun alone, those four files pass: 90 of 90.
- After the last fixes, tests/ui, messages, packs and `tests/core/handoff-hosts.test.ts` were rerun:
  215 of 215 pass.

**Browser.** Built-in browser, `next dev --webpack` on port 3210 with
`PACK_HOSTS=supermarket.localhost=SUPERMARKET,electronics.localhost=ELECTRONICS`. Browsers resolve
`*.localhost` without a hosts file. The data was seeded from the e2e seed into `retails_packs_e2e`.

- Supermarket login at phone width in ar: wordmark, heading and tab title read "Buzzify سوبرماركت".
- A MARKET owner who signs in on the Electronics address is sent to the Supermarket address. That address
  asks for sign-in again, because cookies are per host.
- Shell on the Supermarket address: phone width in ar, and desktop at 1280 px in en ("Buzzify Supermarket").
- A CLOTHING owner on the Supermarket address, where CLOTHING has no host, gets `/unavailable`, which names
  only Supermarket.
- On the shared address the same owner sees "Buzzify ملابس". After the business was flipped to
  ELECTRONICS, it sees "Buzzify إلكترونيات".
- The Electronics login (en) was checked over HTTP: its title, wordmark and heading name Electronics.

**Fixed during the browser check.**

- The tab title showed the product name twice ("X · X").
- The phone header had no room for the wordmark or the business name. This was already true before this
  change, with six icons plus the language select. On phones the product and business now sit on their own
  row above the icons.
- Right after sign-out the tab title went neutral. It now falls back to the address's product.

**Not verified in the browser.**

- Partway through, the pane began refusing `*.localhost` navigations. So the Electronics shell and the
  Clothing pages on a product address were checked only through HTTP and the unit tests.
- ckb was checked only in unit tests.
- Tablet width was not checked.

## Owner's call (follow-up commit)

**The activity type comes from Studio's snapshot only.**

- `saveActivity` (setup step 3, `src/server/setup/progress.ts`) ignores a submitted `activityType` for a shop
  linked to Studio (`coreBusinessId` set) and keeps the stored value. Capabilities and the version still save.
- Chosen: a shop not linked to Studio (dev, tests, a platform-provisioned shop) still chooses it there, so
  the existing setup and acceptance tests are unchanged.
- No other path changes it: core provision sets it only when it creates a business, and the state sync
  does not touch it.
- New tests in `tests/setup/progress.test.ts`: crafted step 3 data (ELECTRONICS, CLOTHING, MIXED) leaves a
  linked MARKET shop as MARKET; an unlinked shop can still change it.
- Not done: a newer Studio snapshot does not update the type of an existing business. Today the type is
  taken only at creation.

**Absolute URLs for a shop.**

- `src/packs/urls.ts` `shopOrigin(activityType)` returns the product's PACK_HOSTS address, else APP_URL.
- Invitation e-mail links now use it.
- New tests in `tests/admin/invitations.test.ts`: a CLOTHING shop's link is on the clothing address, and a
  product without a host falls back to APP_URL.
- The handoff callback keeps using the trusted current address. The not-available redirect already used
  the product address.
- Not done: the invitation mail's wording still says "Buzzify Retails" (neutral).

**Checks for this commit.**

- `tsc` and `eslint` are clean.
- Run together, tests/setup, admin, acceptance, packs and handoff-hosts had 10 failures, all timeouts or
  their knock-on errors under load.
- Rerun alone: r0 and staff-core pass. `tests/admin/support.test.ts` passes 31 of 31 alone.
  `tests/setup/progress.test.ts` and `tests/admin/invitations.test.ts` pass 25 of 25.

## Open problems / not verified
- Server actions do not re-check the host. They run through `loadShell`, which on a product address never
  resolves a business of another product, so another product's business is not reachable there.
- Route ownership per pack (another pack's URL answers 404) is not enforced yet: every pack has the same
  routes today.
- Home tiles and the "More" menu still use the shared till words. Only the header and login use pack words.
- The Studio side must accept a `return` URL on each pack host and send owners to their product's address.
  This was not tested against a real Studio.
- Real Caddy, certificates and DNS were not exercised. A production start with a malformed PACK_HOSTS was
  tested through `register()` in vitest, not with a real `next start`.
