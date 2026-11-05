import type { Locale } from "@/messages";
import type { PackWords } from "../types";

/** Buzzify Clothing's own words. The brand "Buzzify" stays in Latin letters in every locale. */
export const clothingWords: Readonly<Record<Locale, PackWords>> = Object.freeze({
  ar: {
    productName: "Buzzify ملابس",
    productWord: "ملابس",
    loginTitle: "الدخول إلى Buzzify ملابس",
    nav: { sell: "البيع", catalog: "الأصناف", stock: "المخزون", scan: "مسح باركود", setup: "إعداد المنشأة", more: "المزيد" },
    till: { departments: "الأقسام: {n}", categoryItems: "{n} قطعة", open: "عرض" },
  },
  ckb: {
    productName: "Buzzify جلوبەرگ",
    productWord: "جلوبەرگ",
    loginTitle: "چوونەژوورەوە بۆ Buzzify جلوبەرگ",
    nav: { sell: "فرۆشتن", catalog: "کاڵاکان", stock: "کۆگا", scan: "سکانکردنی بارکۆد", setup: "ڕێکخستنی دامەزراوە", more: "زیاتر" },
    till: { departments: "بەشەکان: {n}", categoryItems: "{n} پارچە", open: "بینین" },
  },
  en: {
    productName: "Buzzify Clothing",
    productWord: "Clothing",
    loginTitle: "Sign in to Buzzify Clothing",
    nav: { sell: "Sell", catalog: "Items", stock: "Stock", scan: "Scan a barcode", setup: "Business setup", more: "More" },
    till: { departments: "Sections: {n}", categoryItems: "{n} pieces", open: "View" },
  },
});
