/*
 * Which department a category is. The 23 standard departments are named by key; an owner-made
 * category gets its key from the words in its name (Arabic, Sorani or English), or "other".
 * The key picks the tile's accent colour and glyph.
 */

/** The 23 department keys of the standard supermarket tree (docs/superpowers/specs/2026-11-05-supermarket-standard-categories.md), plus "all" for the All tile. "other" is also the neutral kind for owner-made categories. */
export type CategoryKind =
  | "all"
  | "dairy"
  | "bakery"
  | "fruit_veg"
  | "meat_poultry"
  | "fish"
  | "frozen"
  | "staples"
  | "canned"
  | "spices"
  | "breakfast"
  | "snacks"
  | "sweets"
  | "tea_coffee"
  | "beverages"
  | "cleaning"
  | "personal_care"
  | "baby"
  | "pet"
  | "household"
  | "stationery"
  | "health"
  | "tobacco"
  | "phones"
  | "phone_accessories"
  | "computers"
  | "computer_accessories"
  | "gaming"
  | "tv_audio"
  | "smart_devices"
  | "cameras"
  | "networking"
  | "power"
  | "small_appliances"
  | "sim_credit"
  | "spare_parts"
  | "women"
  | "men"
  | "kids"
  | "infants"
  | "shoes"
  | "bags"
  | "accessories"
  | "underwear"
  | "sportswear"
  | "outerwear"
  | "perfumes"
  | "fabrics"
  | "other";

export const STANDARD_CATEGORY_KEYS = ["dairy", "bakery", "fruit_veg", "meat_poultry", "fish", "frozen", "staples", "canned", "spices", "breakfast", "snacks", "sweets", "tea_coffee", "beverages", "cleaning", "personal_care", "baby", "pet", "household", "stationery", "health", "tobacco", "other"] as const satisfies readonly CategoryKind[];

/** The standard department keys of Buzzify Electronics and Buzzify Clothing (their trees live in src/packs/<product>/departments.ts). */
export const ELECTRONICS_CATEGORY_KEYS = ["phones", "phone_accessories", "computers", "computer_accessories", "gaming", "tv_audio", "smart_devices", "cameras", "networking", "power", "small_appliances", "sim_credit", "spare_parts"] as const satisfies readonly CategoryKind[];
export const CLOTHING_CATEGORY_KEYS = ["women", "men", "kids", "infants", "shoes", "bags", "accessories", "underwear", "sportswear", "outerwear", "perfumes", "fabrics"] as const satisfies readonly CategoryKind[];

type Table = readonly (readonly [CategoryKind, readonly string[]])[];

/** Words (lower case, no diacritics) that choose a drawing; the first kind with a matching word wins. */
const WORDS: Table = [
  ["dairy", ["ألبان", "البان", "لبن", "حليب", "جبن", "أجبان", "اجبان", "زبادي", "قيمر", "زبدة", "شیر", "ماست", "پەنیر", "dairy", "milk", "cheese", "yogurt", "yoghurt", "butter", "eggs"]],
  ["frozen", ["مجمد", "مجمدات", "مثلج", "بوظة", "بستو", "frozen", "ice cream", "icecream"]],
  ["fish", ["أسماك", "اسماك", "سمك", "مأكولات بحرية", "ماكولات بحرية", "روبيان", "ماسی", "fish", "seafood", "shrimp"]],
  ["meat_poultry", ["لحم", "لحوم", "دجاج", "فروج", "مفروم", "گۆشت", "مریشک", "meat", "meats", "chicken", "poultry", "butcher", "beef", "lamb"]],
  ["fruit_veg", ["خضار", "خضروات", "فواكه", "فاكهة", "فاكهه", "ثمار", "تمور", "سەوزە", "میوە", "vegetable", "vegetables", "fruit", "fruits", "produce", "greens", "veg"]],
  ["bakery", ["مخبوز", "مخبوزات", "مخبز", "خبز", "معجنات", "كعك", "بسكويت", "نان", "bakery", "bread", "bakeries", "pastry", "pastries", "cakes", "biscuit", "biscuits"]],
  ["tea_coffee", ["شاي", "شاى", "قهوة", "قهوه", "نسكافيه", "چا", "قاوە", "tea", "coffee", "cafe"]],
  ["beverages", ["مشروب", "مشروبات", "عصير", "عصائر", "مياه", "ماء", "غازي", "طاقة", "خواردنەوە", "ئاو", "شەربەت", "drink", "drinks", "beverage", "beverages", "juice", "juices", "water", "soda", "soft"]],
  ["sweets", ["حلويات", "حلوى", "سكاكر", "شوكولاتة", "شوكولا", "علكة", "شیرینی", "شکولاتە", "sweet", "sweets", "candy", "candies", "chocolate", "dessert", "desserts", "gum"]],
  ["snacks", ["وجبات خفيفة", "خفيفة", "شيبس", "مكسرات", "سناك", "وجبات", "snack", "snacks", "chips", "nuts", "crisps"]],
  ["breakfast", ["إفطار", "افطار", "فطور", "طحينية", "حلاوة", "breakfast", "cereal", "cereals", "spread", "spreads"]],
  ["spices", ["بهارات", "توابل", "تابل", "spice", "spices", "seasoning", "seasonings", "herbs"]],
  ["canned", ["معلبات", "معلب", "تونة", "مخللات", "صلصات", "مربى", "عسل", "كونسروة", "قوتوو", "canned", "tinned", "preserves", "pickles", "jam", "honey", "sauce", "sauces"]],
  ["staples", ["مواد غذائية", "غذائية", "اساسية", "أساسية", "بقالة", "حبوب", "بقوليات", "رز", "أرز", "سكر", "طحين", "زيوت", "سمن", "معكرونة", "خۆراک", "برنج", "گەنم", "grocery", "groceries", "food", "foods", "staples", "grains", "pantry", "oil", "oils", "rice", "flour", "pasta"]],
  ["cleaning", ["منظفات", "تنظيف", "نظافة", "مطهر", "مناديل", "ورق تواليت", "پاککەرەوە", "پاکوخاوێنی", "clean", "cleaning", "detergent", "detergents", "laundry", "tissues", "dishwashing"]],
  ["personal_care", ["عناية", "شخصية", "تجميل", "شامبو", "صابون", "عطور", "پاراستن", "جوانکاری", "care", "personal", "beauty", "cosmetic", "cosmetics", "hygiene", "shampoo", "soap"]],
  ["baby", ["أطفال", "اطفال", "طفل", "رضع", "حفاض", "حفاضات", "منداڵ", "بەچکە", "baby", "babies", "kids", "infant", "diaper", "diapers"]],
  ["pet", ["حيوانات", "أليفة", "اليفة", "قطط", "كلاب", "علف", "pet", "pets", "petfood"]],
  ["household", ["أدوات منزلية", "ادوات منزلية", "منزلية", "مطبخ", "بلاستيك", "بطاريات", "إضاءة", "اضاءة", "تغليف", "household", "kitchenware", "kitchen", "homeware", "plastic", "batteries", "disposable"]],
  ["stationery", ["قرطاسية", "ورقيات", "مكتب", "ألعاب", "العاب", "دفاتر", "قەلەم", "کاغەز", "stationery", "office", "paper", "papers", "school", "toys", "toy"]],
  ["health", ["صحة", "فيتامينات", "فيتامين", "اسعافات", "إسعافات", "تندروستی", "health", "vitamin", "vitamins", "wellness", "supplement", "supplements", "first aid"]],
  ["tobacco", ["تبغ", "سجائر", "تدخين", "كبريت", "جگەرە", "tobacco", "cigarette", "cigarettes", "smoking"]],
];

const fold = (s: string) => s.normalize("NFKD").replace(/[ً-ٰٟـ]/g, "").toLowerCase();

function match(table: Table, names: (string | null | undefined)[]): CategoryKind {
  const text = fold(names.filter(Boolean).join(" "));
  if (text.trim() === "") return "other";
  const raw = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // Arabic names often carry the article "ال": match with and without it.
  const tokens = new Set([...raw, ...raw.filter((t) => t.startsWith("ال") && t.length > 3).map((t) => t.slice(2))]);
  for (const [kind, words] of table) {
    for (const w of words) {
      const f = fold(w);
      if (f.includes(" ") ? text.includes(f) : tokens.has(f) || (f.length >= 4 && [...tokens].some((t) => t.startsWith(f)))) return kind;
    }
  }
  return "other";
}

/** The kind of a category name in a supermarket (any of its names): by keyword, "other" when none matches. */
export function categoryKind(...names: (string | null | undefined)[]): CategoryKind {
  return match(WORDS, names);
}

/** Electronics: the more specific departments (accessories, spare parts, SIM) come before the device they belong to. */
const ELECTRONICS_WORDS: Table = [
  ["phone_accessories", ["ملحقات الهواتف", "ملحقات الجوال", "ملحقات الموبايل", "پێویستیەکانی مۆبایل", "phone accessories", "mobile accessories", "غطاء", "جراب", "واقي", "واقيات", "شاحن", "شواحن", "كفر", "كفرات", "سماعة", "سماعات", "كيبل", "كابل", "case", "cases", "cover", "covers", "charger", "chargers", "cable", "cables", "earphones", "headphones", "powerbank", "کەیس", "شارژەر", "هێدفۆن"]],
  ["spare_parts", ["قطع غيار", "قطع", "تصليح", "صيانة", "spare", "parts", "repair", "پارچەی یەدەگ", "یەدەگ"]],
  ["sim_credit", ["شرائح", "شريحة", "رصيد", "كروت", "sim", "topup", "top-up", "credit", "recharge", "سیمکارت", "کرێدت"]],
  ["computer_accessories", ["ملحقات الحاسوب", "ملحقات الكمبيوتر", "پێویستیەکانی کۆمپیوتەر", "computer accessories", "pc accessories", "لوحة المفاتيح", "لوحات مفاتيح", "ماوس", "كيبورد", "keyboard", "keyboards", "mouse", "webcam", "webcams", "hub", "hubs", "کیبۆرد"]],
  ["gaming", ["ألعاب", "العاب", "بلايستيشن", "playstation", "xbox", "gaming", "games", "game", "console", "consoles", "یاری", "کۆنسۆڵ"]],
  ["smart_devices", ["ذكية", "ذكي", "ساعات ذكية", "smart", "smartwatch", "wearable", "wearables", "زیرەک"]],
  ["phones", ["هواتف", "هاتف", "جوال", "جوالات", "موبايل", "موبايلات", "تلفون", "تابلت", "tablet", "tablets", "phone", "phones", "smartphone", "smartphones", "mobile", "mobiles", "مۆبایل", "مۆبایلەکان", "تابلێت"]],
  ["computers", ["حواسيب", "حاسوب", "كمبيوتر", "لابتوب", "لابتوبات", "طابعات", "طابعة", "شاشات", "computer", "computers", "laptop", "laptops", "pc", "desktop", "desktops", "monitor", "monitors", "printer", "printers", "کۆمپیوتەر", "لاپتۆپ"]],
  ["tv_audio", ["تلفزيونات", "تلفزيون", "تلفاز", "صوتيات", "مكبرات", "tv", "tvs", "television", "audio", "speaker", "speakers", "soundbar", "تەلەفزیۆن", "دەنگ"]],
  ["cameras", ["كاميرات", "كاميرا", "تصوير", "مراقبة", "درون", "camera", "cameras", "cctv", "drone", "drones", "کامێرا"]],
  ["networking", ["شبكات", "شبكة", "راوتر", "راوترات", "انترنت", "router", "routers", "network", "networking", "wifi", "wi-fi", "switch", "switches", "تۆڕ", "ڕاوتەر"]],
  ["power", ["طاقة", "بطاريات", "بطارية", "باور", "مولدات", "شمسية", "battery", "batteries", "power", "ups", "solar", "inverter", "generator", "وزە", "باتری"]],
  ["small_appliances", ["أجهزة منزلية", "منزلية", "مراوح", "مروحة", "سخانات", "غلايات", "مكاوي", "appliance", "appliances", "fan", "fans", "heater", "heaters", "kettle", "kettles", "iron", "irons", "ئامێری ماڵەوە"]],
];

/** Clothing: the product-type departments (shoes, bags, underwear...) come before the person (women, men), so "women's shoes" is shoes. */
const CLOTHING_WORDS: Table = [
  ["underwear", ["ملابس داخلية", "داخلية", "جوارب", "شرابات", "underwear", "socks", "lingerie", "briefs", "جلی ژێرەوە", "گۆرەوی"]],
  ["sportswear", ["ملابس رياضية", "رياضية", "رياضي", "سباحة", "sportswear", "sports", "tracksuit", "tracksuits", "swimwear", "activewear", "وەرزشی"]],
  ["outerwear", ["ملابس شتوية", "شتوية", "شتوي", "معاطف", "جاكيتات", "كنزات", "بلوفر", "coat", "coats", "outerwear", "jacket", "jackets", "winter", "sweater", "sweaters", "زستانە", "زستانی", "کۆت"]],
  ["infants", ["رضع", "رضيع", "مواليد", "حديثي الولادة", "baby", "babies", "infant", "infants", "newborn", "شیرەخۆرە"]],
  ["kids", ["أطفال", "اطفال", "ولادي", "بناتي", "كيدز", "kids", "kid", "children", "boys", "girls", "منداڵان", "منداڵ"]],
  ["shoes", ["أحذية", "احذية", "حذاء", "جزم", "صنادل", "شباشب", "shoes", "shoe", "sandals", "slippers", "sneakers", "boots", "پێڵاو"]],
  ["bags", ["حقائب", "حقيبة", "شنط", "شنطة", "محافظ", "bags", "bag", "handbag", "handbags", "backpack", "backpacks", "wallet", "wallets", "جانتا", "جزدان"]],
  ["perfumes", ["عطور", "عطر", "عناية", "perfume", "perfumes", "fragrance", "fragrances", "cologne", "body care", "عەتر", "چاودێری"]],
  ["fabrics", ["أقمشة", "اقمشة", "قماش", "خياطة", "fabric", "fabrics", "textile", "textiles", "sewing", "قوماش", "دروومان"]],
  ["accessories", ["إكسسوارات", "اكسسوارات", "إكسسوار", "أحزمة", "احزمة", "قبعات", "نظارات", "مجوهرات", "ساعات", "accessories", "accessory", "belts", "hats", "caps", "sunglasses", "jewellery", "jewelry", "watches", "ئەکسسوار", "پشتێن", "کڵاو", "چاویلکە", "خشڵ"]],
  ["women", ["نسائي", "نسائية", "نسائيه", "حريمي", "نساء", "ستاتي", "فساتين", "عبايات", "women", "womens", "woman", "ladies", "dress", "dresses", "abaya", "abayas", "ژنانە", "ژنان", "ئافرەتان"]],
  ["men", ["رجالي", "رجالية", "رجال", "شباب", "men", "mens", "man", "gents", "male", "پیاوانە", "پیاوان"]],
];

/**
 * The kind of a category name for a business of the given product. Each product only reaches its own
 * standard departments: an electronics shop never gets a supermarket tile, and the other way round.
 * Anything that matches none is "other" (a neutral card with a hashed accent).
 */
export function categoryKindFor(pack: "SUPERMARKET" | "ELECTRONICS" | "CLOTHING", ...names: (string | null | undefined)[]): CategoryKind {
  if (pack === "ELECTRONICS") return match(ELECTRONICS_WORDS, names);
  if (pack === "CLOTHING") return match(CLOTHING_WORDS, names);
  return match(WORDS, names);
}
