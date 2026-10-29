# R2 — الاستلام والمخزون: خطة التنفيذ

> **للعاملين الآليين:** المطلوب مهارة `superpowers:subagent-driven-development` (موصى بها) أو `superpowers:executing-plans`. الخطوات بصيغة checkbox.

**الهدف:** دفتر مخزون لا يُعدَّل، أرصدة محسوبة منه، استلام ورصيد افتتاحي وتعديل وإتلاف وعكس، متوسط مرجّح للتكلفة، دفعات وصلاحية، واستيراد الرصيد الافتتاحي، مع شاشات المخزون.

**البنية:** جداول جديدة بنفس نمط R1 (`businessId`، FK مركّبة، تصنيف في `SCOPE_RULES`)، منطق نقي في `src/server/domain/stock.ts`، قلب الدفتر في `src/server/stock/ledger.ts`، المستندات والتعديل والقراءات في `src/server/stock/`، واستيراد الافتتاحي فوق خط استيراد R1.

**التقنية:** كما R0/R1 (Next 16، Prisma 7، PostgreSQL ≥ 15، zod 4، Vitest، Playwright، إصدارات مثبّتة). لا مكتبات جديدة.

**المواصفات:** `docs/superpowers/specs/2026-10-30-retail-r2-stock-design.md` (الملزِم، بما فيه القسم 6ب) و`docs/specs/2026-10-28-retail-design.md`. الفرع: `r2-stock` (متفرع من `r1-catalog`).

## قيود عامة

- الكمية `BigInt` بوحدة الأساس × 1000 (`QTY_SCALE = 1000n`)، والقيمة `BigInt` بالوحدة الصغرى للعملة الأساسية للمنشأة. لا `Number` للكمية ولا للمال.
- الدفتر `RtStockMovement` للإلحاق فقط: UPDATE وDELETE يفشلان في القاعدة (مشغّل). الرصيد لا يُكتب إلا عبر `ledger.ts`. لا رصيد سالب (`CHECK qty >= 0`).
- مستند مُرحَّل لا يُعدَّل ولا يُحذف؛ التصحيح بمستند `REVERSAL` يُرحَّل مرة واحدة بالقيم الأصلية.
- أصناف `isTestData` وأصناف `trackingMode = SERIAL` تُرفض في كل مسار مخزون (`TEST_ITEM`، `SERIAL_NOT_SUPPORTED`).
- القيم والتكلفة لا تظهر في أي استجابة أو لقطة idempotency دون `cost.view`.
- الحدود: 500 سطراً للمستند (عند حفظ المسودة والترحيل)، كمية ≤ 10^12 وحدة أساس، قيمة ≤ `MAX_PRICE_MINOR`.
- كل كتابة `defineAction` (مفتاح، تدقيق، `version`، محظورة في READ_ONLY وCLOSED). الصلاحيات: `stock.receive` (موجودة)، `stock.adjust` و`stock.view` (جديدتان)، `cost.view` (موجودة).
- أقفال بالترتيب: idempotency → قفل المستند → `stock:<variantId>` مرتبة → عداد الأرقام. تعارض 40P01/40001 يُعاد كما في R1.
- الواجهة كما R1: ar/ckb/en بنفس المفاتيح ورسالة لكل `ErrorCode` جديد، CSS منطقي، 375px، أرقام حسب اللغة، حالات التحميل والفراغ وREAD_ONLY.
- كل مهمة تنتهي بـ`npm run lint && npm run typecheck && npm test` أخضر، والنهائية بـ`npx playwright test` (محلياً `E2E_PORT=3190`). الالتزامات تنتهي بـ`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## ما يُؤجَّل عمداً
البيع وFEFO عند البيع، الموردون وأوامر الشراء والتحويل والجرد (R6)، السيريال (R5)، حدود إعادة الطلب، AI (R1b).

## Review Focus
1. مسح الصنف نفسه مرتين في مسودة استلام، وكارتون وقطع منه في مستند واحد: يجمع أو يبقي سطرين بحساب صحيح (المهمة 4).
2. صنف بالكيلو بثلاث خانات عشرية وكارتون بعامل 24: لا كسر خفي ولا تقريب يضيع كمية (المهمتان 1 و4).
3. ضغطتان على «ترحيل» أو إرسال المسودة نفسها من تبويبين: مستند واحد وحركات مرة واحدة (المهمة 4).
4. دفعة منتهية الصلاحية في الرصيد الافتتاحي: تُسجَّل بتحذير ولا تُحسب «متاحة» (المهمتان 4 و6).
5. استلام بالدولار بسعر صرف وتقريب، ثم خروج صغير ألف مرة: لا انحراف في القيمة (المهمتان 1 و3).
6. مستخدم بلا `cost.view` يطلب القائمة والتصدير ونتيجة الترحيل المعاد: لا قيم (المهمتان 4 و6).

---

### Task 1: المنطق النقي والصلاحيات

**الملفات:** إنشاء `src/server/domain/stock.ts`؛ تعديل `src/server/domain/permissions.ts`؛ اختبارات `tests/domain/stock.test.ts` و`tests/domain/permissions.test.ts`.

**الواجهات (يُنتج):**
`QTY_SCALE`, `MAX_BASE_QTY`, `STOCK_REASONS = ["DAMAGED","EXPIRED","LOST","COUNT_FIX","OTHER"]`؛
`toBaseQty(text: string, unit: {factor: number; quantityScale: number}): bigint` (كمية الوحدة المكتوبة ← وحدة الأساس × 1000؛ ترفض الصفر والسالب والخانات الزائدة عن `quantityScale` والتجاوز)؛
`splitIntoUnits(baseQty: bigint, units: {name: string; factor: number}[]): {name: string; count: bigint}[]` (من الأكبر، والباقي بالأساس)؛
`parseRate(text: string): bigint` (دينار لكل 1 دولار × 10^6)؛
`convertMinor(amount: bigint, from: Currency, to: Currency, rateMicro: bigint | null): bigint` (نصف لأعلى؛ نفس العملة بلا سعر؛ مختلفة بلا سعر ← خطأ)؛
`lineValueMinor(unitCostMinor: bigint, text: string, unit): bigint`؛
`reduceValue(onHandQty: bigint, onHandValue: bigint, outQty: bigint): bigint` (متناسب؛ الخروج الأخير يأخذ كل الباقي)؛
`unitCostMinor(qty: bigint, value: bigint, factor: number): bigint`؛
`expiryStatus(expiry: Date | null, today: Date, alertDays: number): "NONE"|"OK"|"SOON"|"EXPIRED"`.
الصلاحيات: `stock.adjust` (OWNER, MANAGER, STOCK)، `stock.view` (كل الأدوار السبعة).

- [ ] **1. اكتب الاختبارات الفاشلة:** `'toBaseQty converts cartons and kilos exactly and rejects extra decimals, zero and negatives'`؛ `'splitIntoUnits shows 2 cartons and 5 pieces for 53 pieces of a 24 carton'`؛ `'convertMinor rounds half up in both directions between IQD and USD'`؛ `'convertMinor refuses different currencies without a rate'`؛ `'reduceValue spends exactly the whole value across 1000 small outflows'` (مجموع الخارج = القيمة الأولى)؛ `'expiryStatus marks SOON inside alertDays and EXPIRED before today'`؛ `'stock.adjust and stock.view follow the matrix and the permission table stays frozen'`.
- [ ] **2. شغّل** ← تفشل. **3. نفّذ** الدوال النقية؛ كل التقريب نصف لأعلى بـBigInt. **4. شغّل** ← تنجح. **5. Commit** `feat: stock domain rules and permissions`

### Task 2: المخطط والترحيل والمشغّلات

**الملفات:** تعديل `prisma/schema.prisma` + ترحيل؛ `src/server/framework/scoped-db.ts`؛ `src/server/admin/support.ts` (نطاق `STOCK_READ` يضم جداول المخزون)؛ اختبار `tests/schema/stock.test.ts`؛ `ErrorCode`ات جديدة ورسائلها الثلاث: `STOCK_NEGATIVE`, `TEST_ITEM`, `SERIAL_NOT_SUPPORTED`, `STOCK_RULE`, `DOCUMENT_POSTED`.

**الواجهات (يُنتج الموديلات):**
`RtBatch {variantId, code?, expiryDate (date)?}` فريد `(businessId, variantId, code, expiryDate)` بـ`NULLS NOT DISTINCT`؛
`RtStockDocument {kind OPENING|RECEIPT|ADJUSTMENT|WRITE_OFF|REVERSAL, status DRAFT|POSTED, number Int?, branchId, locationId, supplierRef?, note?, reason?, reversesDocumentId? (فريد), importBatchId?, postedAt?, postedById?, version}`؛
`RtStockLine {documentId, lineNo, variantId, unitId, batchCode?, expiryDate?, batchId?, quantity BigInt, enteredQuantity String, currency?, unitCostMinor BigInt?, rateMicro BigInt?, valueMinor BigInt?}`؛
`RtStockMovement {documentId, lineId, branchId, locationId, variantId, batchId?, qtyDelta BigInt, valueDeltaMinor BigInt, createdAt}` (بلا `updatedAt`)؛
`RtStockBalance {branchId, locationId, variantId, batchId?, qty BigInt, valueMinor BigInt}` فريد `(businessId, locationId, variantId, batchId)` بـ`NULLS NOT DISTINCT`؛
`RtStockCounter {businessId unique, nextNumber Int}`؛ وعمود `kind` على `RtImportBatch` (`CATALOG|OPENING_STOCK`، الافتراضي `CATALOG`).

- [ ] **1. اكتب الاختبارات الفاشلة:** `'UPDATE and DELETE on a movement fail in the database'`؛ `'a balance with negative qty is refused'`؛ `'two no-batch balances for one location and variant are refused'`؛ `'two identical batches are refused even with null code'`؛ `'a posted document number is unique per business'`؛ `'a document can reverse at most one other document'`؛ `'composite foreign keys keep every row in one business'`؛ `'every new model is classified in scoped-db and in the STOCK_READ support scope'`.
- [ ] **2. شغّل** ← تفشل. **3. نفّذ** المخطط والترحيل؛ المشغّل `BEFORE UPDATE OR DELETE` على الحركات يرفع استثناء؛ CHECKs: `qty >= 0`, `quantity > 0`, قيمة غير سالبة في السطور. صنّف كل الجداول (الحركات والأرصدة والمستندات ثابتة النطاق على المنشأة). تأكد أن `prisma migrate diff` فارغ.
- [ ] **4. شغّل** ← تنجح. **5. Commit** `feat: stock schema, ledger trigger and constraints`

### Task 3: قلب الدفتر

**الملفات:** إنشاء `src/server/stock/ledger.ts`؛ اختبار `tests/stock/ledger.test.ts`.

**الواجهات:** يستهلك المهمتين 1 و2. يُنتج:
`postMovements(tx, p: {businessId, documentId, branchId, locationId, lines: {lineId, variantId, batchId: string | null, qtyDelta: bigint, valueDeltaMinor?: bigint}[]}, lockBusiness): Promise<void>` (يقفل `stock:<variantId>` مرتبة، ينشئ صفوف الرصيد الناقصة بـupsert مع إعادة محاولة، يحسب قيمة الخروج بـ`reduceValue` من متوسط `(موقع، نسخة)` عبر كل الدفعات، يكتب الحركة والرصيد، ويرمي `STOCK_NEGATIVE` قبل أي كتابة)؛
`variantAverage(tx, locationId, variantId): Promise<{qty: bigint; valueMinor: bigint}>`؛
`rebuildBalances(tx, businessId, opts: {fix: boolean}): Promise<{mismatches: {locationId; variantId; batchId; stored; computed}[]}>`.

- [ ] **1. اكتب الاختبارات الفاشلة:** `'receipt then outflow keeps value proportional and zeroes value at zero qty'`؛ `'an outflow larger than the batch balance is STOCK_NEGATIVE and writes nothing'`؛ `'20 concurrent outflows on the last unit let exactly one through'`؛ `'rebuildBalances matches the stored balances after 5000 random movements'`؛ `'rebuildBalances finds and fixes a balance edited by hand'`؛ `'1000 small outflows after a USD-rate receipt leave no value drift'`؛ `'an outflow from a batch uses the variant average, not the batch cost'`؛ `'two businesses never touch each other's balances'`.
- [ ] **2. شغّل** ← تفشل. **3. نفّذ.** **4. شغّل** ← تنجح. **5. Commit** `feat: stock ledger core with rebuild`

### Task 4: الاستلام والرصيد الافتتاحي

**الملفات:** إنشاء `src/server/stock/documents.ts`؛ اختبار `tests/stock/documents.test.ts`.

**الواجهات:** يستهلك المهام 1–3. يُنتج إجراءات (`stock.receive`، والقراءة `stock.view`):
`saveStockDraft({documentId?, expectedVersion?, kind: "OPENING"|"RECEIPT", supplierRef?, note?, lines: DraftLine[]}, meta) → {documentId, version}` حيث `DraftLine = {variantId, unitId, quantity: string, cost?: {amount: string; currency}, rate?: string, batchCode?: string, expiryDate?: "YYYY-MM-DD"}`؛
`discardStockDraft({documentId, expectedVersion})`؛
`postStockDocument({documentId, expectedVersion}, meta) → {number, lines}` (يبني الدفعات، يحسب القيم ويحوّل العملة، يكتب الحركات، يعيد التكلفة لمن يملك `cost.view` فقط)؛
`getStockDocument({documentId})`، `listStockDocuments({kind?, cursor?, limit<=50})`؛ والموقع الافتراضي لفرع المستخدم يُحلّ تلقائياً.
قاعدتان من الخطة: التكلفة **إلزامية** للاستلام، **اختيارية** للافتتاحي (غيابها = صفر مع علامة `costMissing`)؛ سطران لنفس `(نسخة، وحدة، دفعة)` يُجمعان عند الترحيل.

- [ ] **1. اكتب الاختبارات الفاشلة:** `'a receipt of 2 cartons and 5 pieces adds 53 base pieces and a weighted-average cost'`؛ `'a second receipt at another price moves the average'`؛ `'a USD receipt with a rate stores original, rate and converted value'`؛ `'a currency the business does not use is refused'`؛ `'a SERIAL product and a trial product are refused'`؛ `'a tracksExpiry product without an expiry date is refused'`؛ `'an expired batch in OPENING posts with a warning and counts as unavailable'`؛ `'a second OPENING adds, and OPENING is refused after any other movement of that item'`؛ `'posting twice with the same key or from two tabs creates one document and one set of movements'`؛ `'501 lines are refused at draft save'`؛ `'a posted document cannot be edited or discarded'`؛ `'a stock officer receives, a cashier cannot'`؛ `'READ_ONLY refuses save and post'`؛ `'no cost appears in the result or the stored idempotency value without cost.view'`؛ `'another business cannot read or post this document'`؛ `'documents are numbered gap-free per business under concurrency'`.
- [ ] **2. شغّل** ← تفشل. **3. نفّذ.** **4. شغّل** ← تنجح. **5. Commit** `feat: stock receipts and opening balances`

### Task 5: التعديل والإتلاف والعكس

**الملفات:** إنشاء `src/server/stock/adjust.ts`؛ اختبار `tests/stock/adjust.test.ts`.

**الواجهات:** يستهلك 1–4. يُنتج (`stock.adjust`):
`adjustStock({variantId, unitId, batchId?, direction: "IN"|"OUT", quantity: string, reason: "LOST"|"COUNT_FIX"|"OTHER", note?}, meta)`؛
`writeOffStock({variantId, unitId, batchId, quantity: string, reason: "DAMAGED"|"EXPIRED"|"OTHER", note?}, meta)`؛
`reverseStockDocument({documentId, expectedVersion}, meta)`. الزيادة تأخذ المتوسط الحالي (صفراً مع تحذير إن لم يوجد رصيد)؛ الملاحظة إلزامية مع `OTHER`.

- [ ] **1. اكتب الاختبارات الفاشلة:** `'a write-off of damaged goods lowers qty and value proportionally'`؛ `'an adjustment IN uses the current average cost'`؛ `'a reason is required and OTHER needs a note'`؛ `'an outflow beyond the balance is STOCK_NEGATIVE'`؛ `'reversing a receipt posts the exact negation and links to it'`؛ `'a document is reversed once and a reversal cannot be reversed'`؛ `'a reversal is refused when the stock was already used'`؛ `'a cashier cannot adjust, a manager and a stock officer can'`؛ `'the same key does not adjust twice'`.
- [ ] **2. شغّل** ← تفشل. **3. نفّذ** (كلها مستندات مُرحَّلة فورياً عبر `postMovements`). **4. شغّل** ← تنجح. **5. Commit** `feat: stock adjustments, write-offs and reversals`

### Task 6: القراءات وأقفال الكتالوج

**الملفات:** إنشاء `src/server/stock/queries.ts`؛ تعديل `src/server/catalog/products.ts` (`unitIsLocked` وقيد التتبع)؛ اختبارات `tests/stock/queries.test.ts` و`tests/catalog/products.test.ts` (إضافات).

**الواجهات:** يُنتج (`stock.view`، والقيم لـ`cost.view` فقط):
`listStock({query?, categoryId?, expiringOnly?, cursor?, limit<=50}) → {rows: {productId, variantId, nameAr, sku, qty, breakdown, nearestExpiry, status, valueMinor?, avgUnitCostMinor?}[], nextCursor}` (بحث عبر `searchCatalog`)؛
`getVariantStock({variantId}) → {batches: {batchId, code, expiry, status, qty, valueMinor?}[], total}`؛
`listMovements({variantId, cursor?, limit<=50})` (مع الرصيد بعد كل حركة)؛
`listExpiring({withinDays?})` بتوقيت `RtBusiness.timezone`؛
`stockContext() → {role, locationId, canReceive, canAdjust, canSeeCost, defaultCurrency, enabledCurrencies, lastRateMicro?}`.
وفي الكتالوج: `unitIsLocked` تعيد `true` إذا وُجدت حركة أو سطر مسودة لنسخة الوحدة؛ و`updateProduct` ترفض تغيير `trackingMode` و`tracksExpiry` بعد أول حركة (`TRACKING_RULE`).

- [ ] **1. اكتب الاختبارات الفاشلة:** `'the list searches by Arabic name and barcode and shows cartons and pieces'`؛ `'expired batches are not counted as available'`؛ `'listExpiring honours each product's alert days and the business timezone'`؛ `'the movement history shows a running balance that matches the ledger'`؛ `'without cost.view no value or cost field exists in any response'`؛ `'1500 variants page without gaps or repeats'`؛ `'a unit with movements cannot change factor, and tracking and expiry flags are locked'`؛ `'another business never appears'`.
- [ ] **2. شغّل** ← تفشل. **3. نفّذ.** **4. شغّل** ← تنجح. **5. Commit** `feat: stock queries and catalog locks after movements`

### Task 7: استيراد الرصيد الافتتاحي

**الملفات:** إنشاء `src/server/stock/import.ts`؛ اختبار `tests/stock/import.test.ts`؛ تعديل طفيف في `src/server/catalog/import/*` لقبول `kind`.

**الواجهات:** يستهلك `parseImportFile` وخط R1 والمهمة 4. أعمدة: `barcode|sku, quantity, unit, cost, currency, rate, batch, expiry`. يُنتج `stageOpeningImport`, `validateOpeningImport`, `commitOpeningImport({batchId}, meta)` (`stock.receive` + `catalog.import`): التزام على شرائح من 500 سطراً، كل شريحة مستند OPENING مرتبط بـ`importBatchId`، واستئناف بعد الانقطاع، ورفض ملف سبق ترحيله بالـ`fileHash`، ومعاينة تعرض الرصيد الحالي للأصناف التي لها رصيد.

- [ ] **1. اكتب الاختبارات الفاشلة:** `'1200 rows with mixed errors post only the valid ones and keep the rest with reasons'`؛ `'the same file twice posts once'`؛ `'two commits of one batch post nothing the second time'`؛ `'an unknown barcode, a SERIAL item, a trial item and a missing expiry are rejected with reasons'`؛ `'a row for an item that already has stock is flagged before commit'`؛ `'a cashier and a stock officer without catalog.import cannot import'`؛ `'READ_ONLY refuses every step'`؛ `'an interrupted commit resumes the remaining slices'`.
- [ ] **2. شغّل** ← تفشل. **3. نفّذ.** **4. شغّل** ← تنجح. **5. Commit** `feat: opening stock import`

### Task 8: شاشات المخزون (قائمة، حركة، ينتهي قريباً، تعديل)

**الملفات:** إنشاء `src/app/retail/stock/{page,loading}.tsx`، `stock-browser.tsx`، `[variantId]/page.tsx`، `adjust-dialog.tsx`، `expiring/page.tsx`، `actions.ts`؛ الرسائل الثلاث؛ اختبار `tests/ui/stock-ui.test.ts`.

**الواجهات:** تستهلك المهمتين 5 و6 عبر server actions على نمط شاشات الكتالوج. قائمة بحث مباشرة بنفس سلوك البحث (إلغاء الطلبات القديمة)، شارات «ينتهي قريباً/منتهٍ»، عمود القيمة لمن يملك `cost.view` فقط، وزر التعديل لمن يملك `stock.adjust`.

- [ ] **1. اكتب الاختبارات الفاشلة (نمط catalog-ui):** `'the stock list renders cartons and pieces and hides cost without cost.view'`؛ `'the adjust dialog requires a reason and a note for OTHER'`؛ `'every new message key exists in ar, ckb and en'`؛ `'empty, loading, forbidden and READ_ONLY states render'`؛ `'the movement page shows a running balance'`.
- [ ] **2. شغّل** ← تفشل. **3. نفّذ** (انظر قيود الواجهة العامة؛ `break-ui` للأسماء الطويلة والقوائم الكبيرة). **4. شغّل** ← تنجح. **5. Commit** `feat: stock screens`

### Task 9: شاشات الاستلام والافتتاحي والاستيراد وخطوة الإعداد

**الملفات:** إنشاء `src/app/retail/stock/receive/{page,receipt-form}.tsx`، `src/app/retail/stock/import/{page,[batchId]/page}.tsx` و`opening-import-wizard.tsx`؛ تعديل `src/server/setup/progress.ts` (تفعيل الخطوة 6 `openingStock` اختيارية: تكتمل بأول مستند افتتاحي مُرحَّل لصنف غير تجريبي، وتقبل التخطي) و`src/app/retail/setup/*`؛ روابط التنقل؛ اختبارات `tests/ui/receipt-ui.test.ts` و`tests/setup/progress.test.ts` (إضافات).

**الواجهات:** نموذج استلام: مسح/بحث سريع (مسح الصنف نفسه يزيد سطره)، وحدة وكمية وتكلفة وعملة (وسعر صرف يقترح آخر سعر)، دفعة وانتهاء عند الحاجة، حفظ مسودة تلقائي، وزر ترحيل بعد منع الضغط المزدوج؛ ونفس الشاشة لنوع الافتتاحي. معالج استيراد يتبع نمط معالج R1.

- [ ] **1. اكتب الاختبارات الفاشلة:** `'scanning the same barcode twice raises the line quantity'`؛ `'the post button is disabled while a post is in flight'`؛ `'a draft survives a reload'`؛ `'the rate field appears only for a foreign currency and defaults to the last rate'`؛ `'step 6 completes after a posted opening for a real item, can be skipped, and is ignored for trial items'`؛ `'message parity and states'`.
- [ ] **2. شغّل** ← تفشل. **3. نفّذ.** **4. شغّل** ← تنجح. **5. Commit** `feat: receiving, opening and stock import screens`

### Task 10: القبول النهائي

**الملفات:** إنشاء `tests/acceptance/r2.test.ts` و`tests/e2e/stock.spec.ts`؛ تحديث ملاحظات النشر في `docs/` إن لزم.

- [ ] **1. اكتب اختبار القبول:** ماركت: صنف بوحدتين ودفعتين بصلاحيتين، افتتاحي بإكسل، استلام بدولار، تعديل وإتلاف وعكس، `rebuildBalances` تطابق بعد كل خطوة، ولا رصيد سالب، ولا قيمة لمن لا يملك `cost.view`، ومنشأة أخرى لا ترى شيئاً، وREAD_ONLY تمنع الكتابة وتبقي القراءة. اختبار e2e: مسار الاستلام ثم قائمة المخزون وينتهي قريباً بالعربية على 375px.
- [ ] **2. شغّل** الحزمة كاملة: `npm run lint && npm run typecheck && npm test` ثم `E2E_PORT=3190 npx playwright test` ← أخضر؛ و`prisma migrate diff` فارغ.
- [ ] **3. Commit** `test: R2 acceptance and end-to-end`
