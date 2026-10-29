# R1 — الكتالوج: خطة التنفيذ

> **للعاملين الآليين:** المطلوب مهارة `superpowers:subagent-driven-development` (موصى بها) أو `superpowers:executing-plans`. الخطوات بصيغة checkbox.

**الهدف:** كتالوج منشأة كامل: أقسام وعلامات وأصناف ونسخ ووحدات وباركود وأسعار مؤرَّخة، مع بحث عربي سريع واستيراد إكسل/CSV بمعاينة، وواجهة إدخال سريع.

**البنية:** جداول جديدة على مستوى المنشأة تمر كلها عبر العميل المقيَّد وإطار الـAction الموجودين من R0 (إيدمبوتنسي، تدقيق، `version`، البوابة). منطق نقي قابل للاختبار في `src/server/domain/catalog.ts`، والإجراءات في `src/server/catalog/`، والاستيراد في `src/server/catalog/import/`.

**التقنية:** كما في R0 (Next 16، Prisma 7، PostgreSQL، zod 4، Vitest، Playwright، كل شيء بإصدار دقيق مثبَّت). مكتبة قراءة xlsx تُختار في المهمة 8.

**المواصفات:** `docs/superpowers/specs/2026-10-29-retail-r1-catalog-design.md` (الملزِم) و`docs/specs/2026-10-28-retail-design.md` (الأقسام 8 و17). الفرع: `r1-catalog` (متفرع من `r0-foundation`).

## قيود عامة

- المال `BigInt` بالوحدة الصغرى مع `currency` دائماً (دينار 0 خانات، دولار 2). لا `Number` للمال، ولا تحويل بين العملات.
- الباركود **نص** يحفظ الأصفار؛ فريد داخل المنشأة عبر كل الوحدات والنسخ بقيد في القاعدة؛ المؤرشف يبقى محجوزاً.
- لا حذف لصنف أو نسخة أو وحدة أو باركود: `archivedAt` فقط. السعر لا يُحدَّث إلا بإغلاق `validTo` وفتح صف جديد.
- كل جدول جديد يحمل `businessId` ويُصنَّف في `scoped-db.ts` (فشل مغلق). لا استعمال لـ`db` غير المقيَّد خارج المجلدات المستثناة.
- كل كتابة إجراء إطار (`defineAction`): مفتاح إيدمبوتنسي، تدقيق، `version` للتعديل، محظورة في READ_ONLY وCLOSED. القراءة محظورة في CLOSED فقط.
- الصلاحيات تُفحص في الخادم: `catalog.manage` (OWNER, MANAGER, STOCK)، `catalog.import` (OWNER, MANAGER)، `price.change` كما هي. القراءة لكل موظف فعّال.
- الاسم العربي إلزامي؛ الكردي (`ckb`) والإنجليزي اختياريان. الواجهة بـ`ar` و`ckb` و`en` بنفس المفاتيح (اختبار التكافؤ يبقى أخضر) ورسالة لكل `ErrorCode` جديد.
- الواجهة: CSS بخصائص منطقية فقط، `dir` من اللغة، حالات التحميل والفراغ وعدم الصلاحية وREAD_ONLY ظاهرة، وتعمل عند 375px؛ الأرقام تتبع لغة الواجهة؛ لا تقسيم النص إلى حروف.
- الاستيراد: 5,000,000 بايت و10,000 سطر كحد أقصى للدفعة، لا تنفيذ لصيغ إكسل.
- كل مهمة تنتهي بـ`npm run lint && npm run typecheck && npm test` أخضر، والنهائية بـ`npx playwright test` أيضاً. الالتزامات بالنهاية `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## ما يُؤجَّل عمداً

المخزون والدفعات والسيريالات (R2)، البيع والباركود الميزاني (R3)، العروض وقوائم العملاء (R4+)، التكلفة والهامش (R2)، قراءة الصور والذكاء الاصطناعي (R1b)، تجاوز سعر لفرع محدد، شبكة مقاسات/ألوان في الواجهة.

## Review Focus

مدخلات وأعطال يفترضها التصميم وقد لا تغطيها اختبارات مهمة بمفردها (كل سطر له اختبار في المهمة المذكورة):

1. ملف CSV من نظام قديم بترميز Windows-1256 أو UTF-8 مع BOM: الأسماء العربية يجب أن تُقرأ سليمة (المهمة 8).
2. خلية باركود رقمية في إكسل فقدت أصفارها قبل وصولها إلينا، أو رقم طويل صار بصيغة علمية `1.23E+12`: لا يُقبل بصمت، يُرفض السطر برسالة واضحة (المهمة 8).
3. سعر مكتوب بأرقام هندية أو بفاصلة عربية أو بفاصل آلاف (`١٬٢٠٠`)، وسعر دولار بكسور، ودينار بكسور (المهمة 1 و8).
4. باركود مكرر داخل الملف نفسه، وباركود يطابق صنفاً مؤرشفاً، وباركود وحدة صنف آخر (المهمة 8، 9).
5. ضغطتان متتاليتان على «حفظ» في الإدخال السريع أو رفع الملف نفسه مرتين أو دفعتان متزامنتان: لا أصناف مكررة ولا تجاوز لقيد الباركود (المهمة 5، 9).

---

### المهمة 1: المنطق النقي والصلاحيات

**الملفات:** إنشاء `src/server/domain/catalog.ts`؛ تعديل `src/server/domain/permissions.ts`؛ اختبارات `tests/domain/catalog.test.ts` و`tests/domain/permissions.test.ts` (يُحدَّث الجدول المثبَّت).

**الواجهات:**
- يُنتج: `normalizeSearchText(input: string): string`، `normalizeBarcode(input: string): string`، `parseMoneyText(text: string, currency: Currency): bigint`، `assertUnitFactor(n: number): void`، `suggestUnitPrice(baseMinor: bigint, factor: number): bigint`، والثوابت `MAX_BARCODE_LENGTH = 64`، `MAX_UNIT_FACTOR = 100_000`.
- يُنتج: `Permission` تضم `catalog.manage` و`catalog.import`، والمصفوفة كما في قيود عامة.

- [ ] **1. اكتب الاختبارات الفاشلة:** `'normalizeSearchText folds hamza, taa marbuta, tashkeel, tatweel, Arabic-Indic digits and case'` (أمثلة: «أحمد»=«احمد»، «مدرسة»=«مدرسه»، «٣٠٠»=«300»)؛ `'normalizeBarcode keeps leading zeros and converts Arabic-Indic digits'`، `'normalizeBarcode rejects empty, control characters and over 64 characters'`؛ `'parseMoneyText reads Arabic digits, the Arabic decimal and thousands separators'`، `'parseMoneyText refuses fractions for IQD and more than 2 decimals for USD, negatives and garbage'`؛ `'assertUnitFactor accepts only positive integers up to 100000'`؛ `'suggestUnitPrice multiplies exactly in BigInt'`؛ `'catalog.manage and catalog.import follow the matrix and the permission table stays frozen'`.
- [ ] **2. شغّل** ← تفشل.
- [ ] **3. نفّذ** الدوال؛ التوحيد: إزالة التشكيل والتطويل، أ/إ/آ←ا، ة←ه، ى←ي، أرقام هندية وفارسية←لاتينية، تصغير، دمج المسافات. `parseMoneyText` يعيد الوحدة الصغرى (دينار «1,200»→`1200n`، دولار «12.5»→`1250n`).
- [ ] **4. شغّل** الاختبارات ← تنجح.
- [ ] **5. Commit** `feat: catalog domain rules and permissions`

### المهمة 2: المخطط والترحيل والتصنيف

**الملفات:** تعديل `prisma/schema.prisma` + ترحيل جديد؛ تعديل `src/server/framework/scoped-db.ts`؛ اختبار `tests/schema/catalog.test.ts`.

**الواجهات:** يُنتج الموديلات (كلها بـ`businessId`، و`createdAt`، و`version Int @default(1)` حيث يُعدَّل الصف): `RtCategory {parentId?, nameAr, nameCkb?, nameEn?, archivedAt?}`، `RtBrand`، `RtProduct {nameAr…, descriptionAr?…, categoryId?, brandId?, trackingMode (NONE|BATCH|SERIAL), soldByWeight, tracksExpiry, expiryAlertDays?, searchText, archivedAt?}`، `RtVariant {productId, sku, options Json?, searchText, archivedAt?}`، `RtUnit {variantId, name, factor Int, isBase, quantityScale Int, archivedAt?}`، `RtBarcode {unitId, code String, archivedAt?}`، `RtPriceList {name, kind (DEFAULT|WHOLESALE)}`، `RtPrice {unitId, priceListId, currency, amountMinor BigInt, validFrom, validTo?}`، `RtCatalogCounter {businessId unique, nextSku Int}`.

- [ ] **1. اكتب الاختبارات الفاشلة:** `'barcode is unique per business across units and variants, archived ones included'`؛ `'the same code can exist in two different businesses'`؛ `'two open price periods for one unit, list and currency are refused by the database'`؛ `'overlapping price periods are refused'`؛ `'amountMinor must be non-negative; factor must be positive; exactly one base unit with factor 1 per variant'`؛ `'tracksExpiry requires trackingMode BATCH'` (قيد CHECK)؛ `'SKU is unique per business'`؛ `'every new model is classified in scoped-db'` (فحص التصنيف الموجود يفشل أولاً).
- [ ] **2. شغّل** ← تفشل.
- [ ] **3. نفّذ** المخطط والترحيل. القيود تُكتب يدوياً في SQL عند الحاجة: `UNIQUE (businessId, code)` على الباركود، وعدم تداخل الفترات (`EXCLUDE USING gist` على نطاق التاريخ إن توفر `btree_gist` في PostgreSQL المضمَّن وفي حاوية CI؛ وإلا مشغِّل trigger بنفس الأثر والاختبار نفسه)، وفهرس trigram على `searchText` (`pg_trgm`)، وفهرس `RtStaff(userId)` (ترحيل تركة R0). صنِّف الجداول الجديدة في `SCOPE_RULES`. تحقق أن `prisma migrate diff` فارغ وأن فحص الانحراف في CI يمر.
- [ ] **4. شغّل** الاختبارات ← تنجح. تحقق أن الامتدادات تُنشأ في الترحيل (`CREATE EXTENSION IF NOT EXISTS`) وتعمل محلياً وفي CI.
- [ ] **5. Commit** `feat: catalog schema and constraints`

### المهمة 3: نطاق الدعم `catalog.read` يقتصر على جداول الكتالوج

**الملفات:** تعديل `src/server/framework/scoped-db.ts` و`src/server/admin/support.ts`؛ اختبار `tests/admin/support.test.ts` (إضافات).

**الواجهات:** يستهلك: `SupportScope` الموجودة. يُنتج: العميل المقيَّد للقراءة فقط الذي يعطيه `runSupportRead` يسمح بجداول الكتالوج فقط عندما تكون المنحة بنطاق `CATALOG_READ`، ويرفض غيرها بـ`ScopeError`.

- [ ] **1. اكتب الاختبارات الفاشلة:** `'a CATALOG_READ grant reads products but not staff, setup progress, support grants or capabilities'`؛ `'a grant without CATALOG_READ cannot read the catalog'`.
- [ ] **2. شغّل** ← تفشل. **3. نفّذ** خريطة ثابتة `SCOPE_MODELS: Record<SupportScope, readonly ModelName[]>` تُمرَّر إلى غلاف القراءة، مع بقاء الباقي مرفوضاً. **4. شغّل** ← تنجح. **5. Commit** `feat: support scopes limit readable models`

### المهمة 4: الأقسام والعلامات

**الملفات:** إنشاء `src/server/catalog/taxonomy.ts`؛ اختبار `tests/catalog/taxonomy.test.ts`.

**الواجهات:** يُنتج إجراءات `createCategory`, `renameCategory`, `archiveCategory`, `moveCategory`, `createBrand`, `renameBrand`, `archiveBrand`, `listCategories`, `listBrands` (الصلاحية `catalog.manage`، والقراءة لكل عضو). التوقيع بنمط الإطار `(input, meta)`.

- [ ] **1. اكتب الاختبارات الفاشلة:** `'a stock officer creates and renames categories, a cashier cannot'`؛ `'a category cannot become its own ancestor'`؛ `'archiving a category with active children is refused'`؛ `'a stale version gives VERSION_CONFLICT'`؛ `'another business never sees or edits these rows'`؛ `'every write is refused in READ_ONLY'`؛ `'the same idempotency key does not create twice'`.
- [ ] **2. شغّل** ← تفشل. **3. نفّذ** (شجرة بعمق أقصى 4). **4. شغّل** ← تنجح. **5. Commit** `feat: categories and brands`

### المهمة 5: الأصناف والنسخ والوحدات والباركود

**الملفات:** إنشاء `src/server/catalog/products.ts`؛ اختبار `tests/catalog/products.test.ts`؛ ErrorCodes جديدة في `errors.ts` ورسائلها في الرسائل الثلاث (`BARCODE_TAKEN`, `UNIT_RULE`, `TRACKING_RULE`).

**الواجهات:** يستهلك المهمة 1 و2. يُنتج `createProduct(input, meta) → Result<{productId, variantId, baseUnitId, sku}>` (المنتج + نسخة افتراضية + وحدة الأساس + وحدات إضافية اختيارية + باركودات، وسعراً اختيارياً `{currency, amountMinor}` لا يُقبل إلا من يملك `price.change`)، و`updateProduct`, `archiveProduct`, `addVariant`, `addUnit`, `updateUnit`, `archiveUnit`, `addBarcode`, `archiveBarcode`, `getProduct`. ويُنتج `unitIsLocked(tx, unitId): Promise<boolean>` تعيد `false` في R1 (مدخل R2 لقفل المعامل).

- [ ] **1. اكتب الاختبارات الفاشلة:** `'a carton of 24 and a piece are two units of one variant with their own barcodes'`؛ `'a shirt in two sizes and two colours makes four variants with unique SKUs'`؛ `'an existing barcode in createProduct is refused with BARCODE_TAKEN naming the product that owns it'`؛ `'a barcode on an archived product still blocks reuse'`؛ `'SKU is generated per business when empty and never reused'`؛ `'tracksExpiry without BATCH is refused'`؛ `'SERIAL and BATCH are never combined and soldByWeight needs a fractional unit'`؛ `'a stock officer creates a product without a price and is refused when giving a price'`؛ `'a cashier cannot create or edit'`؛ `'two concurrent createProduct calls with the same barcode create exactly one'`؛ `'double submit with the same key creates one product'`؛ `'archive keeps the product readable and frees nothing'`.
- [ ] **2. شغّل** ← تفشل. **3. نفّذ** (توليد SKU بزيادة ذرية على `RtCatalogCounter`؛ التحقق من الباركود قبل الإدراج وقيد القاعدة هو الحَكَم، ويُحوَّل خرقه إلى `BARCODE_TAKEN`). **4. شغّل** ← تنجح. **5. Commit** `feat: products, variants, units and barcodes`

### المهمة 6: الأسعار المؤرَّخة

**الملفات:** إنشاء `src/server/catalog/prices.ts`؛ اختبار `tests/catalog/prices.test.ts`.

**الواجهات:** يُنتج `setPrice({unitId, priceListId, currency, amountMinor, validFrom?}, meta)` (الصلاحية `price.change`)، `getPriceAt({unitId, priceListId, currency, at}, meta)` قراءة، `listUnitPrices({unitId})`، `ensureDefaultLists(tx, businessId)` (تنشئ الافتراضية والجملة عند الحاجة)، و`resolvePrice(tx, {unitId, currency, at, wholesale})` تتراجع من قائمة الجملة إلى الافتراضية.

- [ ] **1. اكتب الاختبارات الفاشلة:** `'changing a price closes the old row and the old date still returns the old price'`؛ `'a future validFrom schedules a price and the current one stays until then'`؛ `'a price can not start before the current one started'`؛ `'carton suggestion is factor times the base price per currency and is not applied automatically'`؛ `'raising the base price does not change the carton price'`؛ `'dinar and dollar prices coexist for one unit'`؛ `'a unit with no wholesale price falls back to the default list'`؛ `'a manager changes prices, a stock officer cannot'`؛ `'a stale price edit gives VERSION_CONFLICT'`.
- [ ] **2. شغّل** ← تفشل. **3. نفّذ** داخل معاملة واحدة مع قفل الصف الحالي. **4. شغّل** ← تنجح. **5. Commit** `feat: dated prices and price lists`

### المهمة 7: البحث

**الملفات:** إنشاء `src/server/catalog/search.ts`؛ اختبار `tests/catalog/search.test.ts`.

**الواجهات:** يُنتج `searchCatalog({query, categoryId?, brandId?, includeArchived?, cursor?, limit<=50}, meta) → {items: CatalogHit[], nextCursor}` حيث `CatalogHit = {productId, variantId, unitId?, nameAr, matchedBarcode?, sku, basePrice?}`. المطابقة التامة للباركود أولاً، ثم SKU، ثم الاسم المُطبَّع بـtrigram. `searchText` يُحدَّث داخل نفس معاملة الإنشاء والتعديل.

- [ ] **1. اكتب الاختبارات الفاشلة:** `'a barcode scan returns the unit that owns it first'`؛ `'Arabic spelling variants and Arabic digits find the same product'`؛ `'a partial name finds products in any language'`؛ `'archived products are hidden unless asked'`؛ `'results are paged and the cursor walks all 1500 seeded products without gaps or repeats'`؛ `'another business never appears'`؛ `'a leading-zero barcode matches only with its zeros'`؛ `'1500 products search in under 200 ms'` (حد مريح، لا اختبار توقيت هشّ: يقيس الخطة بـEXPLAIN أو يستعمل هامشاً واسعاً).
- [ ] **2. شغّل** ← تفشل. **3. نفّذ.** **4. شغّل** ← تنجح. **5. Commit** `feat: fast Arabic-aware catalog search`

### المهمة 8: محرك الاستيراد (قراءة وتحقق)

**الملفات:** إنشاء `src/server/catalog/import/{parse.ts,validate.ts,mapping.ts}`؛ تعديل `prisma/schema.prisma` + ترحيل (`RtImportBatch {status STAGED|VALIDATED|COMMITTED|FAILED, fileName, fileHash, columns Json, mapping Json?, stats Json}`, `RtImportRow {batchId, rowNumber, raw Json, status OK|REJECTED|SKIPPED|CHANGED|COMMITTED, reason?, matchedVariantId?, diff Json?}`)؛ اختبارات `tests/catalog/import/{parse,validate}.test.ts`.

**الواجهات:** يُنتج `parseImportFile(bytes: Uint8Array, name: string): {headers: string[]; rows: string[][]}` (أخطاء: `IMPORT_TOO_LARGE`, `IMPORT_TOO_MANY_ROWS`, `IMPORT_UNREADABLE`)، `validateRows(rows, mapping, existingIndex, businessCurrencies): RowResult[]` نقية، وأعمدة النموذج المعروفة: `barcode, name, nameCkb, nameEn, category, brand, unit, factor, price, currency, sku`. المكتبة: تُختار بنفسك بالمعايير: مثبَّتة بإصدار دقيق، لا ثغرات عالية معروفة، لا تنفِّذ صيغاً، تقرأ الخلايا نصاً، وتحدّ حجم الضغط. وثّق اختيارك في ملاحظة قصيرة في رأس `parse.ts`.

- [ ] **1. اكتب الاختبارات الفاشلة:** `'a UTF-8 CSV with BOM keeps Arabic names'`؛ `'a Windows-1256 CSV is detected and decoded'`؛ `'an xlsx numeric barcode cell that lost its zeros or became scientific notation is rejected with a clear reason'`؛ `'a text barcode cell keeps its leading zeros'`؛ `'formulas are never evaluated'`؛ `'a zip bomb or an over 5 MB file is refused'`؛ `'more than 10000 rows is refused'`؛ `'prices in Arabic digits and separators parse; negative, fractional dinar and unknown currency are rejected'`؛ `'a barcode repeated inside the file rejects the later rows'`؛ `'a row whose barcode belongs to an archived product is rejected'`؛ `'a row matching an existing barcode is CHANGED with a diff, or SKIPPED when identical'`؛ `'a missing name rejects the row and others stay OK'`.
- [ ] **2. شغّل** ← تفشل. **3. نفّذ.** **4. شغّل** ← تنجح. **5. Commit** `feat: import parsing and validation engine`

### المهمة 9: إجراءات الاستيراد

**الملفات:** إنشاء `src/server/catalog/import/actions.ts`؛ اختبار `tests/catalog/import/actions.test.ts`؛ تعديل `next.config.ts` (`serverActions.bodySizeLimit` يتسع للملف الأقصى).

**الواجهات:** يُنتج `stageImport({fileName, contentBase64}, meta) → {batchId, headers, suggestedMapping}`، `validateImport({batchId, mapping}, meta) → {summary, firstRejected[]}`، `commitImport({batchId, onChange: 'SKIP'|'UPDATE'|{[rowNumber]: 'SKIP'|'UPDATE'}}, meta)`، `downloadRejected(batchId)` (CSV بـUTF-8 وBOM مع تعطيل حقن الصيغ بإضافة `'` أمام أي خلية تبدأ بـ`= + - @`)، `listImportBatches`, و`saveMappingPreset/listMappingPresets`. الصلاحية `catalog.import`، والتحديث الذي يغيّر السعر يتطلب `price.change` وإلا يُحدَّث ما سواه فقط.

- [ ] **1. اكتب الاختبارات الفاشلة:** `'importing 1200 rows with mixed errors saves only the valid ones and keeps the rest with reasons'`؛ `'uploading the same file again changes nothing'`؛ `'two commits of one batch create nothing the second time'`؛ `'CHANGED rows are only applied when the user chose UPDATE'`؛ `'an update that changes the price closes the old price, and needs price.change'`؛ `'a manager imports, a stock officer and a cashier cannot'`؛ `'READ_ONLY refuses every import step'`؛ `'the rejected-rows file neutralises formula-looking cells'`؛ `'another business cannot read or commit this batch'`؛ `'a batch whose rows were committed cannot be deleted'`.
- [ ] **2. شغّل** ← تفشل. **3. نفّذ** (الالتزام على شرائح داخل معاملات مع حالة صفوف تُسجَّل لكل شريحة؛ إعادة المحاولة بعد انقطاع تكمل ما لم يُلتزم). **4. شغّل** ← تنجح. **5. Commit** `feat: staged, previewed catalog import`

### المهمة 10: واجهة الكتالوج والإدخال السريع

**الملفات:** إنشاء `src/app/retail/catalog/{page.tsx,loading.tsx,new/page.tsx,[productId]/page.tsx}` ومكوناتها؛ تعديل ملفات الرسائل الثلاثة؛ رابط في `/retail/home`؛ اختبار `tests/e2e/catalog.spec.ts`.

**الواجهات:** يستهلك المهام 4–7 فقط. الإدخال السريع: الحقل الأول باركود؛ باركود موجود ← يفتح الصنف للتعديل؛ جديد ← اسم ← قسم ← (سعر لمن يملك `price.change`) ← Enter يحفظ ويجهّز الصنف التالي، ولوحة المفاتيح تكفي. شاشة الصنف: الوحدات (معامل، باركودات، أسعار بعملتها مع «السعر المقترح الآن»)، تتبع الصلاحية، السائب، الأرشفة. القائمة بحث فوري مع صفحات.

- [ ] **1. اكتب الاختبارات الفاشلة (e2e):** `'a keyboard-only user adds three products in a row by scanning barcodes'`؛ `'scanning an existing barcode opens that product instead of creating a duplicate'`؛ `'a cashier sees the catalog but no edit controls'`؛ `'a 120-character Arabic product name does not break the list at 375px'`؛ `'the list shows prices with the interface digits'`.
- [ ] **2. شغّل** ← تفشل. **3. نفّذ** بالرموز (`tokens.css`) وأنماط الغلاف الموجودة؛ لا مهارات تصميم جديدة، التزم بما هو قائم. **4. شغّل** `npm test && npx playwright test tests/e2e/catalog.spec.ts` ← تنجح. **5. Commit** `feat: catalog screens and quick entry`

### المهمة 11: واجهة الاستيراد، خطوة الإعداد 4، واختبار قبول R1

**الملفات:** إنشاء `src/app/retail/catalog/import/{page.tsx,[batchId]/page.tsx}`؛ تعديل `src/server/setup/progress.ts` (الخطوة 4 متاحة)؛ تعديل صفحة الإعداد؛ اختبارات `tests/setup/progress.test.ts` (تحديث)، `tests/e2e/import.spec.ts`، `tests/acceptance/r1.test.ts`.

**الواجهات:** الخطوة 4 «الكتالوج» تُعلَّم DONE عند وجود صنف فعّال واحد على الأقل أو استيراد ناجح، وأصناف التجربة تحمل `isTestData` ويمكن حذفها (أرشفة جماعية مؤقتة) قبل التشغيل. معالج الاستيراد: رفع ← ربط الأعمدة (مقترح تلقائي ومحفوظ) ← معاينة بحالة كل سطر والفروق ← قرار التحديث/التجاهل ← التأكيد ← ملخص وتنزيل المرفوض.

- [ ] **1. اكتب الاختبارات الفاشلة:** (أ) تحديث `'steps 4... stay PENDING'` ليصبح الاختبار: الخطوة 4 فقط تُنجَز، و6–9 تبقى PENDING. (ب) e2e: `'the owner uploads a CSV with errors, sees the preview, fixes nothing, commits the valid rows and downloads the rejected ones'`. (ج) **اختبار القبول** `tests/acceptance/r1.test.ts` يجمع شروط التصميم (القسم 8): كرتون 24، قميص بـ4 نسخ، تعديل سعر لا يغير سعراً بتاريخ سابق، باركود بأصفاره، باركود مكرر مرفوض في القاعدة، استيراد +1000 سطر مختلط وإعادته، ملف مؤذٍ، عزل بين منشأتين، كاشير لا يعدّل، كل كتابة محظورة في READ_ONLY (بالمسارين: الاشتراك المنتهي وتعليق المنشأة)، وبحث عربي بالصيغ المختلفة.
- [ ] **2. شغّل** ← تفشل. **3. نفّذ** الصفحات والخطوة. **4. شغّل** `npm run lint && npm run typecheck && npm test && npx playwright test` ← الكل أخضر. **5. Commit** `feat: import screens, setup catalog step, R1 acceptance test`

---

## معيار قبول R1

`tests/acceptance/r1.test.ts` أخضر، واختبارات الإنفاذ (`tests/enforcement/`) خضراء، وCI أخضر (يشمل البناء وe2e وفحص انحراف الترحيل)، ولا أثر على `buzzify-core`/`buzzify-menu`.
