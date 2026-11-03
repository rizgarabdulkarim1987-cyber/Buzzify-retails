# Retails speaks its own words: report

Branch `retail-own-words`, cut from `origin/main` (0345eb2, which has the market POS slice). Nothing was pushed, merged or deployed, and no remote database was touched.

## What changed

### 1. One plain way in
- `src/app/login/login-form.tsx`: `LoginForm` takes `handoffHref`. When the handoff is configured, it renders one link button, **Sign in** (ar: دخول, ckb: چوونەژوورەوە), that goes to `/api/core/v1/handoff/start`, plus the failure notice after `?error=core`. The password form, the "or" divider and the intro line are gone from that page. The new `PasswordForm` component holds the email + password form and uses the same throttled `signIn` action as before. When no handoff is configured (`studioSignInHref()` returns null), `/login` falls back to `PasswordForm`, so dev/test environments still work.
- `src/app/login/auth-card.tsx` (new): the shared card, used by both sign-in pages.
- `src/app/admin/login/page.tsx` (new): a staff-only email + password sign-in at `/admin/login`, with `robots: noindex, nofollow`. Nothing on the public page links to it. It sends a visitor who is already signed in onward the same way `/login` does.
- `src/app/admin/page.tsx`: a signed-out visitor to `/admin` is now redirected to `/admin/login` instead of `/login`.
- `src/server/core/handoff.ts`: only the doc comment of `studioSignInHref` changed. It behaves as before: it returns the start path when `CORE_BASE_URL` is set and null otherwise. The function name was left alone because it is never shown to users.
- Auth checks and throttling are unchanged. Both pages call the same `signIn` server action, which goes through `signInThrottled`, and the handoff routes were not edited.

### 2. Messages (en, ar, ckb, plus the Arabic `ERROR_MESSAGES` in `src/server/framework/errors.ts`, which `ar.errors` must equal)

| Key | en (new) | ar (new) | ckb (new) |
|---|---|---|---|
| auth.signIn (was auth.studio) | Sign in | دخول | چوونەژوورەوە |
| auth.or | removed | removed | removed |
| auth.coreFailed | Signing in did not work. Try again in a moment. | تعذّر الدخول. حاول مرة أخرى بعد قليل. | چوونەژوورەوە سەرکەوتوو نەبوو. کەمێکی تر دووبارە هەوڵ بدەرەوە. |
| adminCore.badge | Managed by Buzzify | تديره Buzzify | لەلایەن Buzzify بەڕێوە دەبرێت |
| adminCore.notice | Managed by Buzzify: local changes to the subscription, plan, status or AI switch are overwritten at the next sync. | same meaning | same meaning |
| adminCore.locked | Local editing is disabled. | التعديل المحلي معطّل. | گۆڕانکاری ناوخۆیی ناچالاککراوە. |
| errors.CORE_MANAGED / CORE_UNAVAILABLE / IDENTITY_CONFLICT | "Buzzify" replaces "Studio" / "Buzzify Studio" | same | same |
| setup.staff.roles.CASHIER | Till operator | أمين الصندوق | ئەمینداری سندوق |
| setup.staff.branchesHint | Till operators, stock keepers and purchasing … | أمين الصندوق وأمين المخزن … | ئەمینداری سندوق و کۆگاوان … |

Keys stay in parity. The enum value `CASHIER`, the permission keys, the key `adminCore` and the error codes are unchanged. A search of en, ar and ckb found no restaurant, menu, pharmacy or prescription wording in any message value.

### 3. Tests
- `tests/messages/own-words.test.ts` (new): a word guard. It scans every message value in en, ar and ckb, plus the framework's error texts, for these words: Studio, Core (as a whole word), restaurant, pharmac*, prescription, cashier, ستوديو, مطعم, صيدلي*, كاشير, وصفة طبية, ستۆدیۆ, چێشتخانە, دەرمانخانە, کاشێر. It checks values only, so keys, enum names and code identifiers are allowed by construction. It also tests itself: it confirms each word is caught and that keys such as `adminCore`/`CASHIER` and words such as "score" pass. I ran it red before changing the wording (4 failures, listing each offending value) and green after.
- `tests/ui/login-ui.test.ts`: rewritten for the new page. With the handoff it checks for exactly one `<a>` to the start route, no `<button>`, no email or password inputs, no divider, no "studio" and no `/admin/login` link. Without the handoff it checks for the password form. It also covers the failure notice, the `CORE_BASE_URL` switch, the exact Sign in label in each locale, and `PasswordForm` for `/admin/login`.
- e2e: specs that sign in with email + password now go to `/admin/login`, because the e2e server has the handoff configured. The test id changed from `studio-sign-in` to `handoff-sign-in`. `login.spec.ts` now checks for one button, no password input, no `/admin/login` link and no "studio" text at 375px in ar, ckb and en, plus a test of the staff route.

## Commits
- `62a7b42` feat(login): one plain "Sign in" and Retails' own words
- `1eda63d` test(e2e): password sign-ins go through /admin/login
- `6d5506d` fix(admin): the managed notice opens with the badge's words
- (this report) docs: retail-own-words report

## Verification (all run locally on the embedded Postgres at 54329, databases `retails_test_ownwords` and `retails_e2e_ownwords`)
- `npm run typecheck`: clean. `npm run lint`: clean.
- Full vitest suite: 1107 of 1113 passed in the first full run. There were 6 failures:
  - 1 was real: `tests/admin/core-link-ui.test.ts` expects the badge text inside the row's notice, and the old notice happened to start with the badge words. The new notice begins "Managed by Buzzify: …" in all three languages, which fixed it (commit 6d5506d).
  - 5 were 5000 ms timeouts in DB-heavy files unrelated to this change. The machine was heavily loaded during the run, and a second full run did not finish within the tool's time limit, so it could not be repeated. The 8 files that had any failure or timeout in the full runs (catalog import actions, intake receipts and quota, scoped-db, lock-business, stock ledger, setup progress, app workplace) were re-run on their own: **8 files, 169 tests, all passed**.
  - The messages, login-ui and core-link-ui tests then passed together (4 files, 22 tests).
  - I did not repeat a complete full-suite run after the fix.
- Playwright (port 3159): login.spec, core-handoff.spec and admin-ai.spec, 10 tests:
  - First run: 9 passed. One failed (admin-ai test 1): the cold dev server was still compiling the first password sign-in after the 5 s expect timeout, and the page still showed the Loading… button.
  - Re-run of admin-ai.spec and login.spec: **6 of 6 passed**.
  - The other e2e specs (catalog, import, intake, setup, shell, stock) were only updated mechanically (`/login` became `/admin/login` before the email fill). I did not run them.

## What I saw in the browser (built-in browser pane, dev server on 3157 with `CORE_BASE_URL=https://buzzify.invalid`, then on 3158 without it)
- **ar, `/login?error=core`, 375 px:** The page shows the "Buzzify Retails" wordmark, the language select, the heading "تسجيل الدخول", a red notice "تعذّر الدخول. حاول مرة أخرى بعد قليل." and one green full-width button "دخول". There is no email or password field. The page is right-to-left and has no horizontal overflow.
- **ckb, `/login`:** The heading is "چوونەژوورەوە" and there is one button "چوونەژوورەوە". The page is right-to-left with `lang=ckb`. The only link is `/api/core/v1/handoff/start`, the only input is the locale switcher's hidden action field, there is no "studio" text and no overflow.
- **en, `/login?error=core`, 375 px:** The heading is "Sign in", the notice reads "Signing in did not work. Try again in a moment." and there is one "Sign in" button. Fetching the start route returned a redirect, as expected, towards the (unreachable) configured host. I did not click through to Studio.
- **`/admin/login` (en, 375 px):** The heading is "Sign in", the intro is "Sign in with your email and password.", and the page has the Email field, the Password field and a Sign in button. The meta tag is `robots: noindex, nofollow` and there is no overflow. `/admin` while signed out landed on `/admin/login`.
- **Without `CORE_BASE_URL` (ar, `/login`):** The page shows the old password form (intro, البريد الإلكتروني, كلمة المرور, دخول) and no handoff link.
- I did not sign in with a real password in the browser, because this database has no seeded user. The password sign-in through `/admin/login` was exercised by the e2e admin-ai and core-handoff specs, which passed.
- The dev server added `.next-ownwords` entries to `tsconfig.json`. I reverted that and deleted the build folder. `AGENTS.md` was not changed.

## Rulings
- Ruling: `/admin/login` does not refuse non-admin accounts. Any local email + password account can still sign in there, with the same throttling. — Every e2e spec signs shop owners in with a password, and refusing them would mean signing them in and then out again, which adds new auth code. The route is unlinked and noindexed, and nothing is weaker than before. — Cost if wrong: a shop user who learns the URL can still use a local password. Adding an admin-only check after sign-in is a small follow-up.
- Ruling: signed-out visitors to `/admin` are redirected to `/admin/login`. — Platform admins need a way in now that `/login` has no form, and `/admin` is not a public page. — Cost if wrong: anyone who guesses `/admin` learns the staff route exists. It is still throttled and reveals nothing about accounts.
- Ruling: sign-out still goes to `/login` for everyone. — The admin then has to type `/admin/login`, which keeps the staff route out of anything a shop user sees. — Cost if wrong: a small inconvenience for admins.
- Ruling: the public page with the handoff shows no intro line. The heading and the button both read "Sign in" / دخول / چوونەژوورەوە. — The old intro mentioned email and password, and a single plain button is what was asked for. — Cost if wrong: the word appears twice. Adding a one-line intro would be a small change in three languages.
- Ruling: `coreFailed` no longer suggests the email and password form. — That form is no longer on the page. — Cost if wrong: none for shop users.
- Ruling: "Core" is matched as a whole word, case-insensitive. The generic word "menu" is not guarded. — "Core" must not catch "score", and "menu" is a normal UI word. A search found none today. — Cost if wrong: a future restaurant-menu string would not be caught by the guard.
- Ruling: these internal or non-message strings were left as they are: the audit reason `synced from Studio v<n>` written to `RtFeatureOverride.reason`, `CoreRequestError`'s message, test titles and comments, and e2e seed data (`TERMINAL_A = "كاشير ١"`, user name "علي الكاشير"). — The UI does not render any of them: the override reason is stored, not displayed, and the e2e seeds are test data. — Cost if wrong: if a future audit view shows the reason, the word "Studio" would show up there.
- Ruling: the `studioSignInHref` function name and the `/api/core/...` paths are kept. — They are code identifiers and URLs, not words on the page, and renaming the routes would break the Studio contract. — Cost if wrong: someone reading the URL bar during the redirect sees "core".
- Ruling: commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` instead of the requested "Claude Sonnet 5.5". — The session's attribution instruction names the model that actually did the work, and a Sonnet trailer would misattribute it. — Cost if wrong: the trailer can be changed with a reword before merge.

## Not done or not verified
- No full vitest run passed end to end in one go after the final commit. The details are under Verification.
- The remaining e2e specs (catalog, import, intake, setup, shell, stock) were not run.
- The real Studio sign-in page was not exercised; that is another repo and was out of scope.
