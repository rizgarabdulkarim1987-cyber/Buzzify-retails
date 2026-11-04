# Retails' own sign-in form: report

Branch `retail-own-signin` (from `origin/main` 5b2c90b) in buzzify-retails, and branch `retail-own-signin` in
buzzify-core (worktree `buzzify-menu-retail-link`), first cut from `origin/main` 016cee7a and since rebased on
`origin/main` b963ce7b. Local commits only.

## Security review fixes (second round)

| # | Finding | Fix |
| --- | --- | --- |
| 1 HIGH | Sign-ins counted in `retail:ip` before any sign-in limit, so a spray could starve the AI-key and identity calls | Studio: `/credentials*` count the caller in their own bucket, `retail-signin:ip` (300 / min), and never touch `retail:ip`. Retails: Studio's own limits are applied first, in the server action, before Studio is asked: 20 steps per browser address and 5 password attempts per email per 10 minutes, every attempt counted (`signInAttempt`, sha256 keys in `RtLoginAttempt`). It replaces the old 120 / min count. |
| 2 HIGH | `x-real-ip` fallback; an unknown address shared one `unknown` bucket | Retails reads `X-Forwarded-For` only (`TRUSTED_PROXY_HOPS` from the end; fewer entries than hops gives no address). Without an address it refuses locally, with the generic "Signing in did not work", and does not ask Studio. Studio now refuses a credentials call with an empty `clientIp` (400). |
| 3 MEDIUM | Super admins and platform owners could sign in through another server's form | Studio answers `unavailable` right after the right password (before any code step), and again in `finish`. The answer is the same as for every other refusal. Retails maps Studio's `unavailable` to `ELSEWHERE`: the form says "This account signs in on its own sign-in page." and shows one primary link, "Continue to sign in", to `/api/core/v1/handoff/start` (the browser handoff, so Studio's own sign-in page). |
| 4 MEDIUM | A signed request could be replayed for 120 s | `admitRetailCall(..., { once: true })` on `/credentials*`: after the signature checks out, its sha256 is spent as a `retail-sig:` count (max 1, 240 s window, atomic upsert). A repeat is 401. The cron job prunes the marks (`pruneSpentSignatures`). This is applied only where every body is unique (a fresh nonce each call): two ai-config GETs signed in the same second are identical and genuine. |
| 5 LOW | Better Auth's 400 `INVALID_EMAIL` and an over-1024-char password failed with 503 | Both, and Better Auth's `PASSWORD_TOO_LONG` / `_SHORT`, are now `invalid`. The password field accepts up to 4096 characters, so a long one reaches the `MAX_PASSWORD_LENGTH` check. |

### `TRUSTED_PROXY_HOPS` and the real proxy chain

On the VPS, Caddy runs in front of the Retails container and nothing runs in front of Caddy. With Caddy's default
`reverse_proxy` (no `trusted_proxies`), Caddy ignores any `X-Forwarded-For` the browser sent and sets it to the one
address it saw. Next keeps that header as it is (it only fills `X-Forwarded-For` from the socket when the header is
missing). So the header holds exactly one entry, the browser's, and the default `TRUSTED_PROXY_HOPS=1` is right.

How to check:

1. The Caddyfile's `reverse_proxy` block for the Retails site has no `trusted_proxies`, and no CDN or other proxy
   sits in front of Caddy (DNS points straight at the VPS).
2. From a machine outside, sign in with a wrong password while sending a forged header, for example
   `curl -H 'X-Forwarded-For: 192.0.2.1' ...`. Then, temporarily, log the header the app receives, or read Caddy's
   access log entry: the app must see one entry, your real address. If two entries arrive (a CDN in front, or
   `trusted_proxies` set), set `TRUSTED_PROXY_HOPS=2` so the CDN's own entry is skipped.

If the value is too high, Retails sees fewer entries than hops and refuses every sign-in. If it is too low, every
browser shares the proxy's address and is locked out together.

Retails' own `/login` limits key on the same address, so a wrong value affects both sides alike.

## What was built

- `/login` is now Retails' own form: Email, Password (with a show/hide eye button), "Forgot your password?", one
  primary "Sign in". It sits in a split layout like Studio's sign-in page: the form on the start side and, at 64rem
  and wider, a calm panel on the end side with one short sentence and three lines, each in its own language:
  "Sales, stock and shifts", "المبيعات والمخزون والورديات" and "فرۆشتن، کۆگا و شیفتەکان". On phones the panel is
  hidden and the form is one column. Logical CSS sides only, so ar/ckb mirror.
- When the account has two-factor, the same form shows a code step (6-digit code or a recovery code, like Studio).
  When an owner has several shops, it shows a list to pick one (Studio's existing chooser rule). "Use another
  account" restarts.
- Identity stays in Studio. The server action (`src/app/login/actions.ts`, `signInWithAccount`) calls Studio server to
  server, signed with the existing HMAC scheme (`CORE_OUT_SECRET` here, `RETAIL_CALLER_SECRET` there, via
  `signedCall` / `admitRetailCall`). For each call Retails makes a fresh handoff state on the server and sends only
  its nonce; Studio mints the usual handoff token with that nonce; Retails redeems it at once with
  `completeHandoff` (the callback's own code: signature, 60 s, nonce bound to that state, jti spent once, user
  link, 12 h session). The state never leaves Retails' server, so a leaked token cannot be redeemed elsewhere.
- The two-factor or pick challenge is kept between steps in an HttpOnly, SameSite=Lax, `Path=/login`, 10-minute
  cookie (`rt_signin_step`), never in the page state.
- Without `CORE_BASE_URL` (dev/test), `/login` checks local passwords like before. `/admin/login` is unchanged and
  still uses its own local, throttled password form.
- The browser handoff (`/api/core/v1/handoff/start` and `/callback`) is kept: Studio's "Open Retails" still uses it.
- Word guard: `tests/helpers/own-words.ts` (shared) now also forbids menu words (en `menu(s)`, ar `القوائم`, `منيو`,
  `مينيو`, `قائمة الطعام`, ckb `مینیو`, `ڕێستۆران`); two Arabic catalog texts that said "القوائم" (lists) now say
  "الكتالوج والبحث". The rendered `/login` page is checked against the guard in all 3 locales.
- Forgot password: the link is `${CORE_BASE_URL}/studio/forgot?next=%2Fstudio%2Fretail%2Fcontinue`, the marker
  Studio's sign-in already uses for the neutral (Retail) frame. In Studio, that forgot page's "Back to sign in" now
  goes to Retails' `/login` instead of Studio's sign-in.

## Studio contract (buzzify-core)

All three: `POST`, JSON body, signed exactly like the other `/api/retail/v1/*` calls (`x-bz-timestamp`,
`x-bz-signature` = hex HMAC-SHA256 over `POST\n<path>\n<timestamp>\nsha256(body)`, ±120 s, `RETAIL_CALLER_SECRET`
and its `_PREVIOUS`). Code: `src/server/retail/credentials.ts`, routes under `src/app/api/retail/v1/credentials/`.

| Path | Body |
| --- | --- |
| `/api/retail/v1/credentials` | `{ email, password, clientIp, nonce, userAgent? }` |
| `/api/retail/v1/credentials/two-factor` | `{ challenge, code, clientIp, nonce, userAgent? }` |
| `/api/retail/v1/credentials/choose` | `{ challenge, shopId, clientIp, nonce }` |

`nonce` = base64url(sha256(state)), 43 chars; `clientIp` = an IPv4/IPv6 address, never empty. Answers (200):
`{status:"ok", handoffToken}`, `{status:"needs_2fa", challenge}`, `{status:"choose", challenge, shops:[{id,name,ready}]}`,
`{status:"invalid"}` (wrong email, wrong password, deactivated: one answer), `{status:"invalid_code"}`,
`{status:"expired"}`, `{status:"preparing"}`, `{status:"unavailable"}` (the handoff's own rule refuses: `mayHandOff`,
unverified email; and every super admin or platform owner). 429 `{code:"RATE_LIMITED"}` + `retry-after`;
401 unsigned/old/wrong secret/replayed; 400 malformed (an empty `clientIp` too); 503 link off or misconfigured.

- Password check: `serverAuthFor(prisma).api.signInEmail` (the Studio sign-in's own Better Auth call; same instance
  config without the Next cookie plugin, so no Studio cookie is sent back). The Better Auth session it creates is
  deleted at once.
- Limits: the Studio sign-in's own keys, `signin:ip:<clientIp>` (20 / 10 min) and `signin:email:<email>`
  (5 / 10 min), both counted on every attempt; the code step counts `totp:user:<id>` (5 / 5 min) plus Better Auth's
  own five tries per challenge. `clientIp` is trusted only because the call is signed. Plus the caller's
  count in its own bucket, `retail-signin:ip` (300 / min), apart from the other calls' `retail:ip`.
- 2FA: TOTP and recovery codes (what Studio's sign-in supports). The challenge is Better Auth's signed two-factor
  cookie value, wrapped (`tf.` + base64url); a used recovery code is audited as on Studio.
- Pick: a one-time `verification` row (`retail-pick:<sha256>`), 5 minutes.

## Env vars

No new secret. Retails: `CORE_BASE_URL`, `CORE_OUT_SECRET`, `CORE_HANDOFF_SECRET` as today; optional
`TRUSTED_PROXY_HOPS` (default 1: the last `X-Forwarded-For` entry is the browser's address forwarded to Studio).
Studio: `RETAIL_URL`, `RETAIL_CALLER_SECRET`, `RETAIL_HANDOFF_SECRET` as today.

## Deploy order

**Studio first.** Until Studio serves `/api/retail/v1/credentials`, a deployed Retails `/login` answers every sign-in
with the generic "Signing in did not work" (Studio's 404 is read as a failure). No migration on either side.

## Verified (second round, after the review fixes and the rebase)

- Studio, rebased on `origin/main` b963ce7b. There was one conflict, in `createAuth`, where upstream added
  `authHostOptions`; both changes are kept. `tests/retail/credentials-route.test.ts` (14), the new
  `tests/retail/credentials-hosts.test.ts` and `tests/studio/auth-hosts.test.ts` pass. The new file runs in
  production mode with `PHARMACY_HOST` and `CORE_HOST` set, so Better Auth's base URL depends on the host;
  `serverAuthFor` runs the password, the TOTP code and the token with no request host. `tsc` and `eslint` are clean on
  the changed files. Further suites: see the hand-off.
- Retails: `tests/core/own-sign-in.test.ts` (14), with new tests for the 20 / 5 limits, no address refused without
  asking Studio, and `unavailable` becoming `ELSEWHERE`. The new `tests/ui/login-elsewhere.test.ts` (the link in
  ar/ckb/en, word guard), `tests/ui/login-ui.test.ts` and `tests/messages` pass. `tsc` and `eslint` are clean.
  Playwright `login.spec.ts` and `core-handoff.spec.ts`: 15 / 15.

## Verified (first round)

- Studio (`BUZZIFY_DB_PORT=54339`): `tests/retail/credentials-route.test.ts` (10 tests: unsigned / wrong secret /
  old timestamp refused before anything is counted; one generic `invalid`; per-email and per-address limits on the
  Studio sign-in's own keys, the right password included; TOTP and recovery-code paths, challenge works once;
  `totp:user` limit; chooser and one-time pick; no token for unprovisioned / Super Admin without 2FA / unverified;
  no Studio session or cookie left; password and token in no log). `tests/retail`, `retail-entry`, `space-words`,
  `auth`, `auth-http`, `account`: 391 tests, all pass (one `auth.test.ts` mail-timing test failed once under load,
  passes alone). `tsc` clean; `eslint` reports 4 errors in `src/ui/cart/*`, files this branch does not touch.
  A full-suite run under heavy machine load showed timeouts in pharmacy/people suites this branch does not touch.
- Retails: `tests/core/own-sign-in.test.ts` (12: redeem + session, token redeemable once, generic invalid,
  throttled, 2FA with HttpOnly `/login` cookie, expired step, chooser, restart, Studio unreachable without logging
  the password, Retails-side count, local fallback, forwarded address, signed HTTP client),
  `tests/ui/login-ui.test.ts` (rendered page in ar/ckb/en: fields, eye, forgot link with marker, word guard on
  visible text, panel lines, logical-side CSS, phone layout rules, `/admin/login` unchanged),
  `tests/messages/own-words.test.ts`. `tests/core tests/ui tests/messages tests/auth tests/admin`: all pass except
  `tests/admin/support.test.ts` timeouts (5 s) under load. `tsc` and `eslint` clean. The full suite was run while
  Studio's suite ran on the same machine: 36 failures, all of the ones checked are 5 s timeouts in suites this
  branch does not touch; it was not re-run on a quiet machine.
- Playwright (Chromium, Retails dev server + `tests/e2e/fake-studio.ts`): all 37 e2e tests pass except one
  `catalog.spec.ts` run that hit a 5 s DB transaction timeout (unrelated). `login.spec.ts`: 375 px and 1280 px in
  ar/ckb/en (dir, fields, no forbidden words in the visible text, panel hidden on phones and on the end side on
  desktop, no horizontal scroll), the eye, a wrong password, a full sign-in, a 2FA sign-in, `/admin/login`.
- Looked at screenshots of `/login` at 375 px and 1280 px in ar, ckb, en: the layout is as intended.

## Not verified / open

- Not run against a real Studio: the Retails side was tested with a fake Studio (unit and e2e) and the Studio side
  with its own route tests; the two were never connected end to end.
- The forgot link and the reset page live on the Studio host under `/studio/...`: the address bar shows that host
  and path. The forgot page itself speaks neutral words (existing marker), but the reset e-mail's link
  (`/studio/reset?token=`) carries no marker, so the reset page and its "Back to sign in" use the Studio frame, and
  the e-mail template wording was not changed. Making that neutral needs the entry carried through Better Auth's
  reset mail: not done.
- A spray from many addresses can still fill `retail-signin:ip` (300 / min) and so hold up other people's
  sign-ins for up to a minute. It can no longer touch the AI-key or identity calls.
- `ELSEWHERE` also covers the handoff's other refusals (an unverified email, a POS-only account): those people are
  sent to Studio's sign-in page, which then says why. Only someone who typed the right password sees this.
- `TRUSTED_PROXY_HOPS` must match the real proxy chain (see above). This was not checked on the VPS.
- The `docs/superpowers/reports/retail-own-words-report.md` named in the brief does not exist on `main`.
