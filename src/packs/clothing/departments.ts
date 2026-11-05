import type { DepartmentTree } from "../departments";

/**
 * The standard departments of Buzzify Clothing (docs/superpowers/specs/2026-11-05-electronics-clothing-standard-categories.md).
 * The spec's "baby" key is "infants" here so no key is shared with another pack's departments.
 */
export const clothingDepartments: DepartmentTree = Object.freeze([
  {
    key: "women",
    ar: "نسائي",
    ckb: "ژنانە",
    en: "Women",
    children: [
      { ar: "فساتين", ckb: "کراس", en: "Dresses" },
      { ar: "بلوزات", ckb: "بلووز", en: "Tops" },
      { ar: "بناطيل وتنانير", ckb: "پانتۆڵ و دامێن", en: "Trousers and skirts" },
      { ar: "عبايات وملابس محتشمة", ckb: "عەبا و جلی شەرمین", en: "Abayas and modest wear" },
      { ar: "أوشحة وحجاب", ckb: "شاڵ و حیجاب", en: "Scarves and hijab" },
      { ar: "ملابس نوم", ckb: "جلی خەوتن", en: "Nightwear" },
    ],
  },
  {
    key: "men",
    ar: "رجالي",
    ckb: "پیاوانە",
    en: "Men",
    children: [
      { ar: "قمصان", ckb: "کراس", en: "Shirts" },
      { ar: "بناطيل", ckb: "پانتۆڵ", en: "Trousers" },
      { ar: "بدلات وجاكيتات", ckb: "بەرگ و جاکێت", en: "Suits and jackets" },
      { ar: "ملابس تراثية (دشداشة)", ckb: "جلی کوردی و دشداشە", en: "Traditional wear (dishdasha)" },
      { ar: "تيشيرتات وبولو", ckb: "تیشێرت و پۆلۆ", en: "T-shirts and polo" },
    ],
  },
  {
    key: "kids",
    ar: "أطفال",
    ckb: "منداڵان",
    en: "Kids",
    children: [
      { ar: "أولاد", ckb: "کوڕان", en: "Boys" },
      { ar: "بنات", ckb: "کچان", en: "Girls" },
      { ar: "ملابس مدرسية", ckb: "جلی قوتابخانە", en: "School wear" },
    ],
  },
  {
    key: "infants",
    ar: "رضّع",
    ckb: "شیرەخۆرە",
    en: "Babies",
    children: [
      { ar: "بودي", ckb: "بۆدی", en: "Bodysuits" },
      { ar: "أطقم", ckb: "تاقم", en: "Sets" },
      { ar: "بطانيات", ckb: "بەتانی", en: "Blankets" },
    ],
  },
  {
    key: "shoes",
    ar: "أحذية",
    ckb: "پێڵاو",
    en: "Shoes",
    children: [
      { ar: "نسائية", ckb: "ژنانە", en: "Women" },
      { ar: "رجالية", ckb: "پیاوانە", en: "Men" },
      { ar: "أطفال", ckb: "منداڵان", en: "Kids" },
      { ar: "صنادل وشباشب", ckb: "سندل و دەپێ", en: "Sandals and slippers" },
      { ar: "أحذية رياضية", ckb: "پێڵاوی وەرزشی", en: "Sports shoes" },
    ],
  },
  {
    key: "bags",
    ar: "حقائب",
    ckb: "جانتا",
    en: "Bags",
    children: [
      { ar: "حقائب يد", ckb: "جانتای دەست", en: "Handbags" },
      { ar: "حقائب ظهر", ckb: "جانتای پشت", en: "Backpacks" },
      { ar: "حقائب سفر", ckb: "جانتای گەشت", en: "Travel bags" },
      { ar: "محافظ", ckb: "جزدان", en: "Wallets" },
    ],
  },
  {
    key: "accessories",
    ar: "إكسسوارات",
    ckb: "ئەکسسوار",
    en: "Accessories",
    children: [
      { ar: "أحزمة", ckb: "پشتێن", en: "Belts" },
      { ar: "قبعات وكابات", ckb: "کڵاو", en: "Hats and caps" },
      { ar: "أوشحة", ckb: "شاڵ", en: "Scarves" },
      { ar: "نظارات شمسية", ckb: "چاویلکەی خۆر", en: "Sunglasses" },
      { ar: "مجوهرات", ckb: "خشڵ", en: "Jewellery" },
      { ar: "ساعات", ckb: "کاتژمێر", en: "Watches" },
    ],
  },
  {
    key: "underwear",
    ar: "ملابس داخلية وجوارب",
    ckb: "جلی ژێرەوە و گۆرەوی",
    en: "Underwear and socks",
    children: [
      { ar: "رجالية", ckb: "پیاوانە", en: "Men" },
      { ar: "نسائية", ckb: "ژنانە", en: "Women" },
      { ar: "أطفال", ckb: "منداڵان", en: "Kids" },
      { ar: "جوارب", ckb: "گۆرەوی", en: "Socks" },
    ],
  },
  {
    key: "sportswear",
    ar: "ملابس رياضية",
    ckb: "جلی وەرزشی",
    en: "Sportswear",
    children: [
      { ar: "بدلات رياضية", ckb: "تراکسوت", en: "Tracksuits" },
      { ar: "قمصان رياضية", ckb: "فانیلەی وەرزشی", en: "Sports tops" },
      { ar: "ملابس سباحة", ckb: "جلی مەلە", en: "Swimwear" },
    ],
  },
  {
    key: "outerwear",
    ar: "ملابس شتوية",
    ckb: "جلی زستانە",
    en: "Winter wear",
    children: [
      { ar: "معاطف", ckb: "کۆت", en: "Coats" },
      { ar: "جاكيتات", ckb: "جاکێت", en: "Jackets" },
      { ar: "كنزات", ckb: "کنزە", en: "Sweaters" },
      { ar: "قفازات وأوشحة", ckb: "دەستکێش و شاڵ", en: "Gloves and scarves" },
    ],
  },
  {
    key: "perfumes",
    ar: "عطور وعناية",
    ckb: "عەتر و چاودێری",
    en: "Perfumes and care",
    children: [
      { ar: "عطور", ckb: "عەتر", en: "Perfumes" },
      { ar: "عناية بالجسم", ckb: "چاودێری جەستە", en: "Body care" },
    ],
  },
  { key: "fabrics", ar: "أقمشة ومستلزمات خياطة", ckb: "قوماش و پێداویستی دروومان", en: "Fabrics and sewing" },
  { key: "other", ar: "أخرى", ckb: "هیتر", en: "Other" },
]);
