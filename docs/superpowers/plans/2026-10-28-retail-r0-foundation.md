# Buzzify Retails R0: الأساس. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** مشروع Next.js يقدّم الأساس الآمن لـ Buzzify Retails: منشآت وفروع ومخازن ومحطات، أدوار وصلاحيات، دخول، عزل منشأة وفرع بالاختبارات، بوابة اشتراك، سوبر أدمن، ودعم مؤقت مصرّح، دون أي منطق بيع أو مخزون.

**Architecture:** تطبيق Next.js واحد بقاعدة PostgreSQL واحدة. كل جدول بادئته `Rt`. منطق العمل في `src/server/domain` نقي بلا قاعدة بيانات. كل عملية كتابة تمر عبر إطار `defineAction` الذي يحدد الفاعل والصلاحية ويكتب التدقيق ومفتاح idempotency في المعاملة نفسها. الوصول للبيانات الحساسة عبر عميل محصور بالمنشأة والفرع فقط.

**Tech Stack:** Next.js 16.4.1، React 19، TypeScript strict، Prisma 7.10.1 (`@prisma/adapter-pg`)، PostgreSQL، Better Auth 1.7.10، zod 4.6.7، Vitest، Playwright (للشاشات).

**Spec:** `docs/specs/2026-10-28-retail-design.md` (الأقسام 3 و5 و6 و7 و13 و19 و21، والمرحلة R0 في القسم 12).

## Global Constraints

- كل مبلغ `BigInt` بالوحدة الصغرى مع `currency` (`IQD` بلا كسور، `USD` بسنتين). لا تحويل ضمني بين العملات.
- العملات المفعَّلة للمنشأة: `IQD` و`USD` (قرار 2026-10-28). الدفع المختلط بين العملتين بسعر صرف على الفاتورة يُبنى في R3، لا هنا.
- المنطقة الزمنية الافتراضية `Asia/Baghdad`.
- الأدوار السبعة: `OWNER`, `MANAGER`, `CASHIER`, `STOCK`, `PURCHASING`, `ACCOUNTANT`, `AUDITOR`.
- كل جدول تشغيلي يحمل `businessId`، وما يخص فرعاً يحمل `branchId` بمفتاح خارجي مركّب `(businessId, branchId)`.
- كل صف قابل للتعديل يحمل `version Int` (قفل متفائل). كل عملية كتابة تحمل مفتاح idempotency.
- لا JSON غير منضبط لبيانات مالية أو مخزنية أو صلاحيات. `Json` مسموح لحمولة التدقيق فقط.
- واجهة عربية أولاً RTL، مع `ckb` و`en`. لا رسائل تقنية خام للمستخدم.
- هوية واشتراكات وسوبر أدمن خاصة بالمشروع. لا اعتماد على `buzzify-core` ولا جداول مشتركة معه.
- فواتير اشتراك Buzzify لا تختلط بفواتير بيع المحل (جداول `RtSubscription*` منفصلة تماماً عن أي جدول بيع لاحق).
- لا `migrate deploy` ولا نشر على إنتاج دون موافقة صريحة من المالك.
- **افتراض معلن (يحتاج تأكيد المالك):** بعد انتهاء الاشتراك يبقى النشاط قراءة وتصديراً فقط 90 يوماً ثم يُؤرشف، كما في Pharmacy.

## Review Focus

1. مستخدم عضو في منشأتين يفتح الثانية: لا يرى فروع أو بيانات الأولى ولا تتسرب الجلسة. (Task 4)
2. موظف عُطِّل (`deactivatedAt`) وجلسته ما زالت حية: كل عملية بعد التعطيل تُرفض بخطأ واضح. (Task 3)
3. دعوة المالك: رابط مستخدم مرتين أو منتهٍ أو أُعيد إرساله: يعمل الأحدث فقط ولا يُنشأ مالكان. (Task 7)
4. ضغط زر «إنشاء منشأة» مرتين أو إعادة إرسال الطلب: منشأة واحدة. (Task 5 و7)
5. حدود اليوم عند منتصف الليل بتوقيت بغداد في حساب السماح وانتهاء الاشتراك، واسم منشأة طويل جداً أو بأرقام عربية في الترويسة. (Task 6 و9)

---

## File Structure

```
package.json, tsconfig.json, next.config.ts, vitest.config.ts, eslint.config.mjs
.github/workflows/ci.yml
scripts/check-env.ts
prisma/schema.prisma, prisma/migrations/
src/server/db.ts                       عميل Prisma الأساسي (يُستورد من مكانين فقط)
src/server/domain/permissions.ts       مصفوفة الأدوار والصلاحيات (نقي)
src/server/domain/profiles.ts          ملفات الأنشطة والقدرات وقواعد التوافق (نقي)
src/server/domain/subscription.ts      حالة الاشتراك والبوابة (نقي)
src/server/domain/money.ts             minorUnitDigits والتحقق من العملة (نقي)
src/server/domain/branch-switch.ts     قاعدة السماح بتبديل الفرع (نقي)
src/server/auth/                       إعداد Better Auth والجلسة
src/server/framework/actor.ts          resolveActor
src/server/framework/scoped-db.ts      عميل محصور بالمنشأة والفرع
src/server/framework/action.ts         defineAction
src/server/admin/                      عمليات السوبر أدمن
src/server/support/                    منح الدعم
src/app/retail/                        واجهة المنشأة
src/app/admin/                         واجهة السوبر أدمن
src/messages/{ar,ckb,en}.ts
tests/                                 بنفس بنية المصدر + tests/enforcement/
```

---

### Task 1: هيكل المشروع و CI

**Files:**
- Create: `package.json`, `tsconfig.json` (strict)، `next.config.ts`, `vitest.config.ts`, `eslint.config.mjs`, `.github/workflows/ci.yml`, `scripts/check-env.ts`, `.env.example`, `.gitignore`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Produces: سكربتات `dev`, `build`, `lint`, `typecheck`, `test`, `test:e2e`, `db:migrate`. متغيرات `DATABASE_URL`, `TEST_DATABASE_URL`, `BETTER_AUTH_SECRET`, `APP_URL`.

- [ ] **Step 1: اكتب الاختبار الفاشل** `tests/smoke.test.ts` اسمه `'check-env refuses a missing DATABASE_URL'`: يستدعي `checkEnv({})` ويتوقع أنه يرمي برسالة تذكر `DATABASE_URL`.
- [ ] **Step 2: شغّل** `npx vitest run tests/smoke.test.ts` ← يفشل (الدالة غير معرّفة).
- [ ] **Step 3: نفّذ** `checkEnv(env: Record<string, string | undefined>): void` في `scripts/check-env.ts` بـ zod. ثبّت الإصدارات المذكورة في Tech Stack بأرقام دقيقة (بلا `^`).
- [ ] **Step 4: شغّل** `npm test && npm run typecheck && npm run lint` ← ينجح.
- [ ] **Step 5:** `ci.yml` يشغّل `npm ci` ثم `lint` و`typecheck` و`test` على كل push وpull request، مع خدمة PostgreSQL لـ`TEST_DATABASE_URL`. تحقق بقراءة الملف أنه يحوي الأوامر الثلاثة.
- [ ] **Step 6: Commit** `chore: scaffold Next.js, Vitest and CI`

---

### Task 2: مخطط الهيكل (منشأة، فرع، مخزن، محطة)

**Files:**
- Create: `prisma/schema.prisma`, أول migration، `src/server/db.ts`, `src/server/domain/money.ts`, `tests/helpers/db.ts`
- Test: `tests/schema/structure.test.ts`, `tests/domain/money.test.ts`

**Interfaces:**
- Produces (Prisma): `RtBusiness {id, name, activityType, status RtBusinessStatus(SETUP|ACTIVE|SUSPENDED|ARCHIVED), timezone default "Asia/Baghdad", defaultCurrency, enabledCurrencies Currency[], version, createdAt, updatedAt}`، `RtBranch {id, businessId, name, active, version}` مع `@@unique([businessId, id])`، `RtLocation {id, businessId, branchId, name, sellable Boolean, central Boolean}` بمفتاح مركّب إلى `RtBranch`، `RtTerminal {id, businessId, branchId, locationId, name, active}` بمفتاح مركّب إلى الفرع والموقع. `enum Currency {IQD USD}`.
- Produces (TS): `minorUnitDigits(c: Currency): 0 | 2`، `assertCurrency(v: string): Currency`، `useTestDb(): { db: PrismaClient }` في `tests/helpers/db.ts` يمسح الجداول بين الاختبارات.

- [ ] **Step 1: اكتب الاختبارات الفاشلة:** (أ) `'a location cannot point at a branch of another business'` ينشئ منشأتين وفرعاً لكل منهما ويحاول موقعاً بـ`businessId` الأولى و`branchId` الثانية، ويتوقع خطأ مفتاح خارجي. (ب) `'a terminal cannot use a location of another branch'`. (ج) `'minorUnitDigits'`: IQD يعطي 0 وUSD يعطي 2، و`assertCurrency('EUR')` يرمي.
- [ ] **Step 2: شغّل** ← تفشل.
- [ ] **Step 3: اكتب** المخطط والـmigration (`npx prisma migrate dev --name structure` على `TEST_DATABASE_URL` المحلية فقط) ودوال `money.ts`.
- [ ] **Step 4: شغّل** ← تنجح.
- [ ] **Step 5: Commit** `feat: business, branch, location and terminal schema`

---

### Task 3: الهوية والموظفون والصلاحيات

**Files:**
- Create: `src/server/auth/auth.ts` (Better Auth: بريد وكلمة مرور وجلسات)، `src/server/domain/permissions.ts`, `src/server/framework/actor.ts`
- Modify: `prisma/schema.prisma` (جداول Better Auth، `RtStaff`, `RtStaffBranch`, `enum RtRole`) + migration
- Test: `tests/domain/permissions.test.ts`, `tests/framework/actor.test.ts`

**Interfaces:**
- Produces: `type Permission` بالقيم: `cost.view`, `price.change`, `discount.override`, `return.noInvoice`, `refund`, `count.adjust.approve`, `stock.receive`, `stock.transfer`, `supplier.pay`, `staff.manage`, `data.export`, `ai.use`, `multiBranch.access`, `support.grant`.
- Produces: `can(role: RtRole, p: Permission): boolean` و`permissionsOf(role): ReadonlySet<Permission>`.
- Produces: `resolveActor(userId: string, businessId: string): Promise<Actor>` حيث `Actor = { userId; businessId; role: RtRole; branchIds: string[] | 'ALL' }`. يرمي `ActorError('NOT_A_MEMBER' | 'DEACTIVATED')`.
- جداول: `RtStaff {id, businessId, userId, role, deactivatedAt?}` فريد `(businessId, userId)`، `RtStaffBranch {staffId, businessId, branchId}` بمفتاح مركّب إلى الفرع.

- [ ] **Step 1: اكتب الاختبارات الفاشلة:** (أ) `'CASHIER cannot view cost or change prices'`. (ب) `'only OWNER and ACCOUNTANT hold cost.view and data.export'`. (ج) `'AUDITOR holds no write permission'` يفحص أن كل صلاحية كتابة (`price.change, discount.override, refund, stock.receive, stock.transfer, supplier.pay, staff.manage`) خارج مجموعته. (د) `'resolveActor refuses a deactivated staff member'`. (هـ) `'resolveActor refuses a user who belongs to another business'`.
- [ ] **Step 2: شغّل** ← تفشل.
- [ ] **Step 3: نفّذ** المصفوفة كجدول ثابت `Record<RtRole, readonly Permission[]>` والـ`resolveActor` بقراءة واحدة لـ`RtStaff` مع الفروع. المالك والمدير `branchIds: 'ALL'` عبر `multiBranch.access`.
- [ ] **Step 4: شغّل** ← تنجح.
- [ ] **Step 5: Commit** `feat: staff, roles, permissions and actor resolution`

---

### Task 4: عميل محصور بالمنشأة والفرع + اختبارات التطبيق

**Files:**
- Create: `src/server/framework/scoped-db.ts`, `tests/enforcement/no-direct-db.test.ts`
- Test: `tests/framework/scoped-db.test.ts`

**Interfaces:**
- Consumes: `Actor` (Task 3)، `db` (Task 2).
- Produces: `scopedDb(actor: Actor): PrismaClient` (امتداد Prisma يعيد كتابة كل استعلام). النماذج التي تحمل `businessId` تُصفَّى به دائماً. النماذج التي تحمل `branchId` تُصفَّى بـ`actor.branchIds` ما لم تكن `'ALL'`. الإنشاء يفرض `businessId` من الفاعل ويرفض `branchId` خارج نطاقه بـ`ScopeError`.
- Produces: قوائم `BUSINESS_SCOPED_MODELS` و`BRANCH_SCOPED_MODELS` مصدّرة، ويفشل اختبار إن أُضيف نموذج `Rt*` يحمل `businessId` دون أن يُدرج في إحداهما.

- [ ] **Step 1: اكتب الاختبارات الفاشلة:** (أ) `'a cashier of branch A cannot read a location of branch B'`. (ب) `'a user of business 1 reads nothing of business 2'` (مستخدم بعضوية في منشأتين، يفتح الأولى ثم الثانية، لا تسرب). (ج) `'create with a foreign branchId throws ScopeError'`. (د) `'every Rt model with a businessId column is listed as scoped'` يقرأ `Prisma.dmmf`. (هـ) اختبار تطبيق: `'feature folders never import the base db'` يمسح `src/app` و`src/server` ما عدا `src/server/db.ts` و`src/server/framework/` و`src/server/auth/` و`src/server/admin/` ويفشل إن وجد استيراداً لـ`@/server/db`.
- [ ] **Step 2: شغّل** ← تفشل.
- [ ] **Step 3: نفّذ** `scopedDb` بـ`$extends({ query: { $allModels: { $allOperations } } })`. العمليات المركّبة (`$transaction` داخلياً) تستخدم العميل نفسه.
- [ ] **Step 4: شغّل** ← تنجح.
- [ ] **Step 5: Commit** `feat: business and branch scoped client with enforcement tests`

---

### Task 5: إطار العمليات (الصلاحية، التدقيق، idempotency، الإصدار)

**Files:**
- Create: `src/server/framework/action.ts`, `src/server/framework/errors.ts`
- Modify: `prisma/schema.prisma` (`RtAuditLog`, `RtIdempotency`) + migration
- Test: `tests/framework/action.test.ts`

**Interfaces:**
- Consumes: `resolveActor`, `can`, `scopedDb`.
- Produces: `defineAction<I, O>(spec: { name: string; permission: Permission | null; input: ZodType<I>; writes: boolean; run(ctx: { actor: Actor; tx: PrismaClient; input: I }): Promise<O> }): (raw: unknown, meta: { userId: string; businessId: string; idempotencyKey: string }) => Promise<Result<O>>`. `Result<O> = { ok: true; value: O } | { ok: false; code: ErrorCode; message: string }` (الرسائل عربية بلغة العمل).
- Produces: `RtIdempotency {businessId, key, payloadHash, result Json, createdAt}` فريد `(businessId, key)`. `RtAuditLog {id, businessId?, actorId, action, entity, entityId, changes Json, at}`.
- `ErrorCode`: `FORBIDDEN`, `INVALID_INPUT`, `VERSION_CONFLICT`, `IDEMPOTENCY_MISMATCH`, `READ_ONLY`, `NOT_FOUND`.

- [ ] **Step 1: اكتب الاختبارات الفاشلة:** (أ) `'refuses without permission and writes no audit row'`. (ب) `'a repeated idempotencyKey with the same payload returns the stored result and runs once'`. (ج) `'the same key with another payload returns IDEMPOTENCY_MISMATCH'`. (د) `'the audit row and the change commit together; if run throws neither exists'`. (هـ) `'a stale version returns VERSION_CONFLICT'`.
- [ ] **Step 2: شغّل** ← تفشل.
- [ ] **Step 3: نفّذ** داخل `db.$transaction`: حل الفاعل، فحص الصلاحية، فحص البوابة (Task 6 تُدمج لاحقاً عبر `gate` اختياري في الـspec)، فحص idempotency، التنفيذ، التدقيق، تخزين النتيجة. `payloadHash` = sha256 للمدخل بعد `JSON.stringify` مرتب المفاتيح.
- [ ] **Step 4: شغّل** ← تنجح.
- [ ] **Step 5: Commit** `feat: action framework with audit and idempotency`

---

### Task 6: الاشتراك والبوابة (مستقل عن أي نظام آخر)

**Files:**
- Create: `src/server/domain/subscription.ts`
- Modify: `prisma/schema.prisma` (`RtPlan`, `RtSubscription`, `RtSubscriptionEvent`, `RtSubscriptionPayment`, `RtFeatureOverride`) + migration، و`src/server/framework/action.ts` (استدعاء البوابة)
- Test: `tests/domain/subscription.test.ts`, `tests/framework/gate.test.ts`

**Interfaces:**
- Produces: `type GateMode = 'FULL' | 'READ_ONLY' | 'CLOSED'` و`gateFor(sub: { status; trialEndsAt?; currentPeriodEnd; graceDays; cancelledAt? } | null, now: Date, retentionDays = 90): GateMode`. بدون اشتراك: `CLOSED`.
- Produces: `RtPlan {code, limits: branches, terminals, users, storageMb, aiMonthly (أعمدة Int لا JSON)}`، `RtSubscription {businessId, planCode, status, trialEndsAt, currentPeriodStart, currentPeriodEnd, graceDays default 7, cancelledAt}` بحد أقصى اشتراك حي واحد لكل منشأة (فهرس فريد جزئي في migration).
- Produces: `RtFeatureOverride {businessId, feature, enabled, reason ≥10 chars, grantedById, createdAt}`.
- قاعدة الكتابة: `writes: true` تُرفض بـ`READ_ONLY` عند غير `FULL`. القراءة والتصدير مسموحان في `READ_ONLY`.

- [ ] **Step 1: اكتب الاختبارات الفاشلة** (بتوقيت `Asia/Baghdad`): (أ) `TRIAL` قبل `trialEndsAt` ← `FULL`. (ب) `ACTIVE` بعد نهاية الفترة بيوم وضمن السماح ← `FULL`. (ج) بعد السماح ← `READ_ONLY`. (د) بعد 90 يوماً من نهاية السماح ← `CLOSED`. (هـ) `CANCELLED` ← `READ_ONLY` حتى 90 يوماً من الإلغاء. (و) نهاية الفترة عند 23:59:59 بغداد مقابل 00:00:00 اليوم التالي. (ز) `'a write action on a READ_ONLY business returns READ_ONLY and a read action succeeds'`.
- [ ] **Step 2: شغّل** ← تفشل.
- [ ] **Step 3: نفّذ** `gateFor` نقية، وأضف فحص البوابة في `defineAction`.
- [ ] **Step 4: شغّل** ← تنجح.
- [ ] **Step 5: Commit** `feat: own subscription model and gate`

---

### Task 7: السوبر أدمن: إنشاء المنشأة والدعوة والحالة

**Files:**
- Create: `src/server/admin/provision.ts`, `src/server/admin/invitations.ts`, `src/server/admin/lifecycle.ts`, `src/server/domain/profiles.ts`
- Modify: `prisma/schema.prisma` (`RtPlatformAdmin`, `RtInvitation`, `RtCapability`) + migration
- Test: `tests/admin/provision.test.ts`, `tests/admin/invitations.test.ts`, `tests/domain/profiles.test.ts`

**Interfaces:**
- Produces: `provisionBusiness(input: { name: string; activityType: ActivityType; capabilities: Capability[]; branches: { name: string }[] (1 إلى 20); ownerEmail: string; currencies: Currency[]; planCode: string; trialDays: number }, meta): Result<{ businessId: string }>` تكتب في معاملة واحدة: المنشأة (`SETUP`)، الفروع، موقعاً افتراضياً لكل فرع، اشتراكاً تجريبياً، القدرات، دعوة المالك، التدقيق.
- Produces: `type ActivityType = 'MARKET' | 'CLOTHING' | 'ELECTRONICS' | 'BEAUTY' | 'STATIONERY' | 'MIXED'`، `type Capability = 'VARIANTS' | 'SERIAL' | 'BATCH' | 'WEIGHT' | 'MULTI_UNIT' | 'WARRANTY' | 'WHOLESALE' | 'LOYALTY' | 'CREDIT' | 'HOLDS' | 'TRANSFERS'`، `defaultCapabilities(a: ActivityType): Capability[]`، و`validateCapabilities(c: Capability[]): { ok: true } | { ok: false; reason: 'SERIAL_BATCH_CONFLICT' }`.
- Produces: `inviteOwner(businessId, email)` تخزن SHA-256 للرمز فقط، صلاحية 7 أيام. `resendInvitation(invitationId)` تُبطل السابقة. `acceptInvitation(token: string, userId: string)` تنشئ `RtStaff` بدور `OWNER` مرة واحدة فقط وتفعّل المنشأة من `SETUP` إلى `ACTIVE`.
- Produces: `setBusinessStatus(businessId, next: RtBusinessStatus, reason: string)` بانتقالات مسموحة فقط: `SETUP→ACTIVE`, `ACTIVE↔SUSPENDED`, `ACTIVE|SUSPENDED→ARCHIVED`.
- Produces: `overrideFeature(businessId, feature, enabled, reason)` يسجل `RtFeatureOverride` ويدقق.

- [ ] **Step 1: اكتب الاختبارات الفاشلة:** (أ) `'MARKET defaults include BATCH and WEIGHT, CLOTHING includes VARIANTS'`. (ب) `'SERIAL and BATCH together are refused'`. (ج) `'provisionBusiness writes business, branches, default locations, trial subscription, invitation and audit together or not at all'` (يفشل في منتصفها فلا يبقى شيء). (د) `'the same idempotencyKey creates one business'`. (هـ) `'zero branches or 21 branches are refused'`. (و) `'accepting an invitation twice or after resend of a newer one fails and creates one owner'`. (ز) `'an expired invitation is refused'`. (ح) `'ARCHIVED cannot return to ACTIVE'`. (ط) `'override without a reason of 10 characters is refused'`.
- [ ] **Step 2: شغّل** ← تفشل.
- [ ] **Step 3: نفّذ** العمليات بـ`defineAction` (`permission: null` والفحص على `RtPlatformAdmin` لأنها خارج أي منشأة، وتُوثَّق هذه الاستثناء بتعليق في الملف). البريد في التطوير يُكتب إلى `.data/mail/`.
- [ ] **Step 4: شغّل** ← تنجح.
- [ ] **Step 5: Commit** `feat: super admin provisioning, invitations and lifecycle`

---

### Task 8: الدعم المؤقت المصرّح

**Files:**
- Create: `src/server/support/grants.ts`
- Modify: `prisma/schema.prisma` (`RtSupportGrant`) + migration
- Test: `tests/support/grants.test.ts`

**Interfaces:**
- Produces: `RtSupportGrant {id, businessId, granteeId, scopes, reason, expiresAt, revokedAt?, grantedById}`. النطاقات: `catalog.read`, `stock.read`, `sales.read`.
- Produces: `grantSupport(input: { businessId; granteeId; scopes: SupportScope[]; reason: string; hours: number }): Result<{ grantId }>`: السبب 10 أحرف فأكثر، المدة 72 ساعة كحد أقصى، يمنحها المالك (`support.grant`). `revokeSupport(grantId)` فوري. `resolveSupportActor(grantId, userId): Actor` يرمي إن انتهت أو أُلغيت، ويعيد فاعلاً للقراءة فقط بالنطاقات الممنوحة.
- كل قراءة دعم تكتب صف تدقيق `support.read` **قبل** القراءة، وتفشل القراءة إن فشلت الكتابة.

- [ ] **Step 1: اكتب الاختبارات الفاشلة:** (أ) `'a platform admin without a grant is refused like a stranger'`. (ب) `'73 hours or a 9-character reason is refused'`. (ج) `'a revoked or expired grant reads nothing'` (بما فيها لحظة الانتهاء بالضبط). (د) `'every support read writes an audit row first, and fails if the audit cannot be written'`. (هـ) `'a support actor cannot write and never sees cost'`.
- [ ] **Step 2: شغّل** ← تفشل.
- [ ] **Step 3: نفّذ** الخدمة. لا انتحال صامت لمستخدم المحل: الفاعل يحمل `viaSupportGrantId` ويظهر في الواجهة.
- [ ] **Step 4: شغّل** ← تنجح.
- [ ] **Step 5: Commit** `feat: time-boxed audited support access`

---

### Task 9: غلاف الواجهة، الترويسة، اختيار المنشأة والفرع والمحطة

**Files:**
- Create: `src/app/retail/layout.tsx`, `src/app/retail/select/page.tsx`, `src/app/retail/home/page.tsx`, `src/app/admin/page.tsx` (قائمة المنشآت ونموذج الإنشاء)، `src/messages/ar.ts`, `ckb.ts`, `en.ts`, `src/server/domain/branch-switch.ts`
- Test: `tests/domain/branch-switch.test.ts`, `tests/messages/parity.test.ts`, `tests/e2e/shell.spec.ts`

**Interfaces:**
- Produces: `canSwitchBranch(state: { openDrafts: number; openShift: boolean }): { allowed: true } | { allowed: false; reason: 'OPEN_DRAFTS' | 'OPEN_SHIFT' }`. (البيانات الفعلية للمسودات والورديات تأتي في R3. هنا الواجهة تمرر صفراً.)
- Produces: الترويسة تعرض دائماً اسم المنشأة والفرع والمحطة إن وجدت والمستخدم، وتقتطع الاسم الطويل بنقاط دون كسر التخطيط، وتبقى الأرقام بحسب لغة الواجهة.
- Produces: `messages.ar`, `messages.ckb`, `messages.en` بالمفاتيح نفسها، والأخطاء بلغة العمل لكل `ErrorCode`.

- [ ] **Step 1: اكتب الاختبارات الفاشلة:** (أ) `'switching is refused with open drafts or an open shift'`. (ب) `'ar, ckb and en have exactly the same keys'`. (ج) e2e: `'a cashier of branch A sees only branch A on the select page'` و`'the header shows business, branch, terminal and user'` و`'an 80-character business name does not overflow the header at 375px width'`.
- [ ] **Step 2: شغّل** ← تفشل.
- [ ] **Step 3: نفّذ** الصفحات بـ`dir="rtl"` للعربية والسورانية. حالات التحميل والفراغ وعدم الصلاحية ظاهرة في كل صفحة. التصميم عبر مهارة impeccable ثم 21st-ui-build عند هذه الخطوة، لا قبلها.
- [ ] **Step 4: شغّل** `npm test && npx playwright test tests/e2e/shell.spec.ts` ← ينجح.
- [ ] **Step 5: Commit** `feat: retail shell, header and branch/terminal selection`

---

### Task 10: معالج الإعداد الأولي (الهيكل) وبوابة قبول R0

**Files:**
- Create: `src/app/retail/setup/page.tsx`, `src/server/setup/progress.ts`
- Modify: `prisma/schema.prisma` (`RtSetupProgress`) + migration
- Test: `tests/setup/progress.test.ts`, `tests/acceptance/r0.test.ts`

**Interfaces:**
- Produces: `RtSetupProgress {businessId, step Int (1..9), status (PENDING|DONE|SKIPPED), isTestData Boolean}`. في R0 تنفَّذ الخطوات: 1 (بيانات النشاط والعملة والمنطقة الزمنية)، 2 (الفروع والمخازن)، 3 (نوع النشاط والقدرات)، 5 (الموظفون والأدوار). الباقي تظهر «قريباً» مع حالة `PENDING` ولا تُعلَّم منجزة.
- Produces: `completeSetupStep(businessId, step, data): Result<void>` و`getSetupProgress(businessId): SetupStep[]`.

- [ ] **Step 1: اكتب الاختبارات الفاشلة:** (أ) `'progress survives a reload and steps 4, 6, 7, 8, 9 stay PENDING'`. (ب) **اختبار القبول** `tests/acceptance/r0.test.ts`: `'a super admin creates a business with two branches and invites an owner, the owner accepts, adds a cashier for branch A, and the cashier cannot read branch B, another business, or any write while the subscription is READ_ONLY'`. وعدم المساس بـ`buzzify-core` يُتحقق منه يدوياً في الخطوة 5، وليس باختبار آلي.
- [ ] **Step 2: شغّل** ← تفشل.
- [ ] **Step 3: نفّذ** الخدمة والصفحة.
- [ ] **Step 4: شغّل** `npm run lint && npm run typecheck && npm test && npx playwright test` ← الكل أخضر في CI محلياً.
- [ ] **Step 5: تحقق يدوي:** `git -C ../buzzify-menu status -sb` يطابق ما كان قبل بدء R0 (لا تغيير في `buzzify-core`).
- [ ] **Step 6: Commit** `feat: setup wizard steps 1-3 and 5, R0 acceptance test`

---

## ما لا يشمله R0 (مقصود)

الكتالوج والوحدات والباركود (R1)، المخزون (R2)، البيع والورديات والطباعة (R3)، وكل ما بعدها. لا مفاتيح AI ولا أجهزة في R0.

## معيار قبول R0

اختبار `tests/acceptance/r0.test.ts` أخضر، واختبارات التطبيق (`tests/enforcement/`) خضراء، وCI أخضر، ولا أثر على `buzzify-core`.
