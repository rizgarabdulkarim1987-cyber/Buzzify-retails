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
  | "other";

export const STANDARD_CATEGORY_KEYS = ["dairy", "bakery", "fruit_veg", "meat_poultry", "fish", "frozen", "staples", "canned", "spices", "breakfast", "snacks", "sweets", "tea_coffee", "beverages", "cleaning", "personal_care", "baby", "pet", "household", "stationery", "health", "tobacco", "other"] as const satisfies readonly CategoryKind[];

/** Words (lower case, no diacritics) that choose a drawing; the first kind with a matching word wins. */
const WORDS: readonly (readonly [CategoryKind, readonly string[]])[] = [
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

/** The kind of a category name (any of its names): by keyword, "other" when none matches. */
export function categoryKind(...names: (string | null | undefined)[]): CategoryKind {
  const text = fold(names.filter(Boolean).join(" "));
  if (text.trim() === "") return "other";
  const raw = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // Arabic names often carry the article "ال": match with and without it.
  const tokens = new Set([...raw, ...raw.filter((t) => t.startsWith("ال") && t.length > 3).map((t) => t.slice(2))]);
  for (const [kind, words] of WORDS) {
    for (const w of words) {
      const f = fold(w);
      if (f.includes(" ") ? text.includes(f) : tokens.has(f) || (f.length >= 4 && [...tokens].some((t) => t.startsWith(f)))) return kind;
    }
  }
  return "other";
}
