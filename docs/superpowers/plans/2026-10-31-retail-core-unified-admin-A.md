# الربط بالسوبر أدمن الموحّد — الجزء A (داخل Retails) — خطة التنفيذ

> **للمنفّذين:** استعملوا superpowers:subagent-driven-development (مُوصى به) أو superpowers:executing-plans. الخطوات بصيغة `- [ ]`.

**الهدف:** أن يتزوّد Retails ويتزامن ويستقبل الدخول من Studio عبر واجهات موقّعة، ويسحب مفتاح Anthropic منه، ويُختبر كل ذلك بخادم Studio وهمي، بدون لمس `buzzify-menu`.

**المعمارية:** Studio مصدر الحقيقة. Retails يحتفظ بنسخة محلية (يطبّق «صورة حالة» مرقّمة على جداوله الحالية `RtBusiness/RtPlan/RtSubscription/RtFeatureOverride`، فلا يتغير `gateOf` ولا الحصة). الدخول برمز تسليم موقّع قصير العمر يُنشئ جلسة Better Auth محلية. المفتاح يُسحب بنداء موقّع ويُخزَّن 60 ثانية في الذاكرة.

**التقنيات:** Next.js 16 (اقرأ `node_modules/next/dist/docs/` قبل أي كود route handler أو cookies)، Prisma 7، Better Auth، zod 4، Vitest، Playwright.

**الوثيقة:** `docs/superpowers/specs/2026-10-31-retail-core-unified-admin-design.md` (الأقسام 5 و9 ملزمة؛ المواصفة هي المرجع عند التعارض).

## قيود عامة
- ترحيلات إضافية فقط (أعمدة nullable وجداول جديدة)، لا حذف ولا تعديل لترحيلات قائمة. لا تلمس منطق R2 للترحيل ولا `gateOf` ولا حصة الذكاء الاصطناعي.
- التوقيع: HMAC-SHA256 على `METHOD\nPATH\nTIMESTAMP\nSHA256(body)`، ترويسات `x-bz-timestamp` و`x-bz-signature` (hex)، نافذة ±120 ثانية، مقارنة `timingSafeEqual`، سرّان مقبولان (`CORE_SYNC_SECRET` و`CORE_SYNC_SECRET_PREVIOUS`). اتجاه Retails→Studio يوقّع بـ`CORE_OUT_SECRET`.
- رمز التسليم: `base64url(json).base64url(hmac)` بسرّ `CORE_HANDOFF_SECRET` (+`_PREVIOUS`)، حقول: `aud:"retail"`, `exp` (≤ 60 ث من `iat`), `nonce`, `jti`, `coreUserId`, `email`, `emailVerified`, `name`, `coreBusinessId`. يُرفض أي رمز عمره أكبر من 60 ثانية أو `aud` غير `retail`.
- لا يُسجَّل في أي سجل: المفتاح، الجسم، الرمز، السر. الأخطاء تسجّل صنفها ورقم الحالة فقط.
- متغير `ANTHROPIC_API_KEY` للرجوع الاحتياطي في غير الإنتاج فقط (`NODE_ENV !== "production"`).
- مدة الجلسة القصوى 12 ساعة (`session.expiresIn`).
- نصوص الواجهة الجديدة ar/ckb/en بنفس تماثل المفاتيح الموجود. التزام: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` في كل commit.

## تركيز المراجعة (مدخلات يهملها المنطق عادةً)
1. صورة حالة بنسخة أقدم أو مساوية تصل بعد أحدث → تُتجاهل دون خطأ، وبعد ترتيب معكوس (v6 ثم v5) تبقى v6.
2. حالة `state` تصل قبل `provision` → 404 قابل للإعادة (لا إنشاء ضمني).
3. تكرار `provision` بنفس `coreBusinessId` → نفس النتيجة، محل واحد.
4. رمز تسليم مستعمل أو منتهٍ أو لمستمع آخر أو مبدّل الإيميل → رفض، ولا جلسة.
5. إيميل غير موثَّق في الرمز + مستخدم محلي بنفس الإيميل بلا `coreUserId` → لا ربط (لا استيلاء).
6. محل SUSPENDED يبقى قراءة فقط بعد الدخول، وARCHIVED يُغلق (سلوك البوابة الحالي).
7. تعذّر Studio وقت سحب المفتاح → آخر قيمة في الذاكرة، ثم رجوع (غير إنتاج)، ثم `AI_UNAVAILABLE` مع استرجاع نصف الوحدة كما اليوم.

---

### Task 1: الترحيلة والنماذج

**الملفات:** `prisma/schema.prisma`، ترحيلة جديدة `20261101100000_core_link`، اختبار `tests/core/schema.test.ts`.

**يُنتج:**
- `RtBusiness.coreBusinessId String? @unique`، `RtBusiness.coreOwnerUserId String?`، `RtBusiness.coreStateVersion Int?`.
- `User.coreUserId String? @unique`.
- `model RtCoreNonce { jti String @id; expiresAt DateTime; @@index([expiresAt]) }`.

- [ ] **1. اختبار** `schema.test.ts`: إدخال محلين بنفس `coreBusinessId` يفشل بالقيد الفريد؛ محلان بـ`null` ينجحان؛ كذلك `User.coreUserId`؛ `RtCoreNonce` يرفض `jti` مكرراً.
- [ ] **2.** عدّل المخطط وولّد الترحيلة بـ`prisma migrate dev --create-only` وراجع أنها إضافية فقط؛ صنّف `RtCoreNonce` في `scoped-db.ts` كجدول غير مقيَّد (مثل `RtLoginAttempt`) وتأكد أن اختبار تصنيف الجداول الموجود يمر.
- [ ] **3.** شغّل الاختبار + `npm run typecheck` + `prisma migrate diff` (shadow `retails_shadow`) فارغ. Commit: `feat: core link columns and nonce table`.

### Task 2: التوقيع والتحقق والحد من المعدل

**الملفات:** إنشاء `src/server/core/{signing,config}.ts`، `tests/core/signing.test.ts`.

**يُنتج (تواقيع ثابتة):**
```ts
signRequest(method: string, path: string, body: string, secret: string, now?: Date): { "x-bz-timestamp": string; "x-bz-signature": string }
verifyRequest(req: { method: string; path: string; body: string; headers: Headers }, now?: Date): { ok: true } | { ok: false; reason: "MISSING" | "SKEW" | "BAD_SIGNATURE" }   // يجرّب السرّين
signHandoffForTests / verifyHandoff(token: string, now?: Date): { ok: true; claims: HandoffClaims } | { ok: false; reason: "FORMAT"|"SIGNATURE"|"EXPIRED"|"AUDIENCE" }
coreConfig(): { baseUrl: string; secrets: ...}   // يقرأ البيئة ويفشل بوضوح عند غيابها في الإنتاج
```
- [ ] **1. اختبارات:** توقيع صحيح يمر؛ جسم/مسار/طريقة مغيّرة تفشل؛ ±120 ث حد القبول (119 يمر، 121 يفشل)؛ السر السابق يمر؛ رمز تسليم: عمر 61 ث يفشل، `aud` خاطئ يفشل، توقيع مبدَّل يفشل.
- [ ] **2.** نفّذ. حدّ المعدل: دالة `coreRateLimit(key)` فوق `RtLoginAttempt` بمفتاح مجزّأ `core:` (120 طلباً/دقيقة للعنوان) مع اختبار.
- [ ] **3.** Commit: `feat: signed core requests and handoff tokens`.

### Task 3: التزويد `POST /api/core/v1/provision`

**الملفات:** تعديل `src/server/admin/provision.ts` (استخراج `provisionInTx` بلا مسؤول منصة)، إنشاء `src/server/core/state.ts`، `src/app/api/core/v1/provision/route.ts`، `tests/core/provision.test.ts`.

**يستهلك:** المهمتان 1 و2. **يُنتج:**
```ts
export const coreStateSchema: ZodType<CoreState>   // انظر الشكل أدناه
applyCoreState(tx, businessId, state): Promise<{ applied: boolean }>   // الأحدث فقط
```
شكل `CoreState`: `{ coreBusinessId, version: int≥1, status: "ACTIVE"|"SUSPENDED"|"ARCHIVED", plan: { code, name, maxBranches, maxTerminals, maxUsers, storageMb, aiMonthly }, subscription: { status: القيم الموجودة في SubscriptionStatus, trialEndsAt|null, currentPeriodStart, currentPeriodEnd, graceDays }, aiIntake: boolean, owner: { coreUserId, email, emailVerified, name } }`.

- [ ] **1. اختبارات:** (أ) طلب موقّع صحيح ينشئ محلاً بفروعه ومواقعه وقدراته وحالته `SETUP`→ثم تُطبَّق الصورة، و`coreBusinessId` محفوظ، والاستجابة `{businessId}`؛ (ب) نفس الطلب مرتين ينتج محلاً واحداً؛ (ج) توقيع خاطئ 401 ولا كتابة؛ (د) خطة أكبر من الفروع المطلوبة → 422 بلا كتابة؛ (هـ) لا تُنشأ دعوة مالك.
- [ ] **2.** `provisionInTx(tx, input)` تُستدعى من `provisionBusiness` الحالي (سلوك لا يتغير، واختباراته الحالية تبقى خضراء) ومن المسار الجديد.
- [ ] **3.** `applyCoreState`: يتجاهل `version ≤ coreStateVersion`؛ يضبط `RtBusiness.status` (SETUP يتحول إلى ACTIVE عند أول صورة إن كان `status` ACTIVE) ؛ يُحدّث/ينشئ `RtPlan` بالرمز المرسل (حدود من الصورة) ؛ يُحدّث الاشتراك الحي أو ينشئه؛ يضيف صف `RtFeatureOverride` لـ`ai.intake` فقط عند تغيّر القيمة (السبب: `synced from Studio v<n>`، `grantedById: "core-sync"`)؛ يخزّن `coreOwnerUserId` و`coreStateVersion`؛ كله داخل معاملة واحدة.
- [ ] **4.** Commit: `feat: core provisioning endpoint`.

### Task 4: المزامنة `POST/GET /api/core/v1/state` و`GET /health`

**الملفات:** `src/app/api/core/v1/state/route.ts`، `src/app/api/core/v1/health/route.ts`، `tests/core/state.test.ts`.

- [ ] **1. اختبارات:** صورة أحدث تُطبَّق وتغيّر الحالة والحدود؛ أقدم/مساوية تُتجاهل (200 `{applied:false}`)؛ ترتيب معكوس v6 ثم v5 ينتهي بـv6؛ `coreBusinessId` مجهول 404؛ SUSPENDED → `gateOf` يعطي READ_ONLY، ARCHIVED → CLOSED؛ تفعيل `aiIntake` ثم تعطيله يغيّر `featureEnabled`؛ `GET state?coreBusinessId=` موقّع يعيد `{version, status, aiUsageMonth: {month, units}}` (من `RtAiUsage`)؛ `health` لا يتطلب توقيعاً ويعيد `{ok:true}`.
- [ ] **2.** نفّذ المسارات فوق `applyCoreState` والتحقق؛ Commit: `feat: core state sync endpoints`.

### Task 5: الدخول برمز التسليم

**الملفات:** `src/app/api/core/v1/handoff/start/route.ts` و`.../callback/route.ts`، `src/server/core/handoff.ts`، تعديل `src/server/auth/auth.ts` (`session.expiresIn = 12h`)، زر «الدخول عبر Studio» في `src/app/login/login-form.tsx`، رسائل ar/ckb/en، `tests/core/handoff.test.ts`.

**يُنتج:** `completeHandoff(token, stateCookie): Promise<{ ok:true; userId; businessId } | { ok:false; reason }>` و`startHandoff(returnTo): { redirectTo; stateCookie }`.

- [ ] **1. اختبارات:** (أ) رمز صحيح لمالك المحل ينشئ المستخدم المحلي ويربطه بـ`coreUserId`، وينشئ/يضمن `RtStaff` بدور OWNER، ويعيد جلسة؛ (ب) نفس الرمز مرتين يفشل (`jti`)؛ (ج) `state` لا يطابق الكوكي يفشل؛ (د) إيميل غير موثَّق + مستخدم محلي قائم بلا `coreUserId` → لا ربط ولا جلسة؛ (هـ) إيميل موثَّق + مستخدم محلي قائم → يُربط؛ (و) `coreUserId` مربوط بإيميل مختلف يعتمد `coreUserId` (لا إنشاء ثانٍ)؛ (ز) مستخدم غير مالك وغير موظف في المحل → دخول مع رفض الوصول للمحل (لا دور)؛ (ح) `returnTo` خارج المسارات الداخلية يُرفض؛ (ط) حذف `RtCoreNonce` المنتهية عند كل استدعاء.
- [ ] **2.** `start`: يولّد `state`، يضعه في كوكي HttpOnly/SameSite=Lax قصير العمر، ويحوّل إلى `${CORE_BASE_URL}/api/retail/v1/handoff?return=<callback>&state=<state>`. `callback`: يتحقق، ينشئ الجلسة عبر `(await auth.$context).internalAdapter.createSession` ويضع كوكيها بأدوات Better Auth (راجع وثائقه المثبّتة؛ إن لم تتوفر الواجهة اكتب الأقل لازماً واشرح)، ثم يحوّل إلى `/retail`. الدخول بكلمة السر المحلية يبقى للتطوير وحسابات الطوارئ.
- [ ] **3.** Commit: `feat: sign-in via Studio handoff`.

### Task 6: عميل Studio، سحب المفتاح، ودعوة الموظف

**الملفات:** `src/server/core/client.ts`، `src/server/core/client-fake.ts`، تعديل `src/server/intake/provider-claude.ts`، تعديل مسار دعوة الموظف في `src/server/admin/invitations.ts`/معالج الموظفين الموجود (اقرأه أولاً)، `tests/core/client.test.ts`، `tests/intake/provider-key.test.ts`.

**يُنتج:**
```ts
interface CoreClient {
  getAiConfig(): Promise<{ apiKey: string; model: string | null }>
  ensureIdentity(email: string, name?: string): Promise<{ coreUserId: string; created: boolean }>
}
resolveAnthropicKey(): Promise<{ apiKey: string; model: string | null } | null>
```
- [ ] **1. اختبارات:** السحب يُخزَّن 60 ث (نداء واحد لطلبين)، بعدها يُعاد؛ فشل Studio يعيد آخر قيمة؛ بلا قيمة وبلا إنتاج يرجع لـ`ANTHROPIC_API_KEY`؛ في الإنتاج بلا Studio → `null` فيرمي المزود `AiUnavailableError("config")`؛ لا يظهر المفتاح في أي سجل (تحقق على `console`)؛ النداء موقّع بـ`CORE_OUT_SECRET` ويستخدم `fetch` بمهلة 5 ثوان؛ دعوة موظف بإيميل: يستدعي `ensureIdentity` ويربط `coreUserId` عند وجود محل مرتبط، وبدون ربط (محل مستقل) يعمل المسار الحالي بلا تغيير.
- [ ] **2.** نفّذ، وبدّل في `provider-claude.ts` قراءة `process.env.ANTHROPIC_API_KEY` بـ`resolveAnthropicKey()` (النموذج من Studio إن وُجد، ثم `INTAKE_MODEL`، ثم الافتراضي).
- [ ] **3.** Commit: `feat: Studio client and key pull`.

### Task 7: التحذير، القبول، والتوثيق

**الملفات:** تعديل صفحات `src/app/admin/*` (شارة تحذير «مرتبط بـStudio — الأصل هناك» لمحل له `coreBusinessId`، وتعطيل تعديل الاشتراك المحلي بزر مع تلميح)، `tests/acceptance/core-link.test.ts`، `tests/e2e/core-handoff.spec.ts`، تحديث `docs/deployment-notes.md` (المتغيرات الأربعة، قيد الخروج أحادي الجانب، تدوير الأسرار).

- [ ] **1. اختبار القبول** بـStudio وهمي: تزويد ← صورة حالة ← دخول مالك برمز ← إضافة موظف بإيميل يملك هوية سابقة ← تعليق (SUSPENDED) فقراءة فقط ← تفعيل `aiIntake` ← قراءة وصل بمزود وهمي بمفتاح مسحوب ← أرشفة فإغلاق. e2e بـ375px: صفحة الدخول تعرض زر Studio ويعمل التحويل مع خادم وهمي (Playwright route).
- [ ] **2. شغّل:** `npm run lint && npm run typecheck && npm test` ثم `E2E_PORT=3190 npx playwright test` و`prisma migrate diff` فارغ.
- [ ] **3.** Commit: `test: core link acceptance and docs`.

---

## قرارات اتخذتها في الخطة (تُراجَع)
- لا تُنشأ دعوة مالك للمحلات المرتبطة؛ الدخول بالتسليم فقط (المالك هو `owner` في الصورة).
- إنهاء الجلسات عند الإيقاف **لم يُدرج**: البوابة تمنع الكتابة أو تغلق، والجلسة محدودة بـ12 ساعة. إن أراد المالك إنهاءً فورياً تُضاف مهمة صغيرة.
- خطط Studio تُحمَّل كصفوف `RtPlan` برمزها وحدودها من الصورة (مصدرها Studio).
- جزء B (في `buzzify-menu`) لا يدخل هذه الخطة؛ تحسم أول مهمة فيه أين تُخزَّن الحدود في Studio الحي.
