# Retails' own sign-in form: report

Branch `retail-own-signin` (from `origin/main` 5b2c90b) in buzzify-retails, and branch `retail-own-signin`
(from `origin/main` 016cee7a) in buzzify-core (worktree `buzzify-menu-retail-link`). Local commits only.

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

`nonce` = base64url(sha256(state)), 43 chars; `clientIp` = IPv4/IPv6 or `""`. Answers (200):
`{status:"ok", handoffToken}`, `{status:"needs_2fa", challenge}`, `{status:"choose", challenge, shops:[{id,name,ready}]}`,
`{status:"invalid"}` (wrong email, wrong password, deactivated: one answer), `{status:"invalid_code"}`,
`{status:"expired"}`, `{status:"preparing"}`, `{status:"unavailable"}` (the handoff's own rule refuses: `mayHandOff`,
unverified email). 429 `{code:"RATE_LIMITED"}` + `retry-after`; 401 unsigned/old/wrong secret; 400 malformed;
503 link off or misconfigured.

- Password check: `serverAuthFor(prisma).api.signInEmail` (the Studio sign-in's own Better Auth call; same instance
  config without the Next cookie plugin, so no Studio cookie is sent back). The Better Auth session it creates is
  deleted at once.
- Limits: the Studio sign-in's own keys, `signin:ip:<clientIp>` (20 / 10 min) and `signin:email:<email>`
  (5 / 10 min), both counted on every attempt; the code step counts `totp:user:<id>` (5 / 5 min) plus Better Auth's
  own five tries per challenge. `clientIp` is trusted only because the call is signed. Plus the existing
  `retail:ip` count of the caller (300 / min).
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

## Verified

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
- Sign-ins through Retails share Studio's `retail:ip` budget (300 / min per Retails egress) with the AI-key pull and
  identities calls; a login spray from many addresses could use it up. Retails' own `signin` count (120 / min per
  browser address) only limits single addresses.
- `TRUSTED_PROXY_HOPS` must match the real proxy chain in front of Retails; if wrong, every browser shares one
  address bucket at Studio (20 failures / 10 min lock everyone out) or the address can be forged (the per-email limit
  still holds).
- The `docs/superpowers/reports/retail-own-words-report.md` named in the brief does not exist on `main`.
