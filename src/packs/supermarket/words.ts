import type { Locale } from "@/messages";
import type { PackWords } from "../types";

/** Buzzify Supermarket's own words. The brand "Buzzify" stays in Latin letters in every locale. */
export const supermarketWords: Readonly<Record<Locale, PackWords>> = Object.freeze({
  ar: {
    productName: "Buzzify سوبرماركت",
    productWord: "سوبرماركت",
    loginTitle: "الدخول إلى Buzzify سوبرماركت",
    nav: { sell: "البيع", catalog: "المنتجات", stock: "المخزون", scan: "مسح باركود", setup: "إعداد المنشأة", more: "المزيد" },
    till: { departments: "الأقسام: {n}", categoryItems: "{n} مادة", open: "فتح" },
  },
  ckb: {
    productName: "Buzzify سوپەرمارکێت",
    productWord: "سوپەرمارکێت",
    loginTitle: "چوونەژوورەوە بۆ Buzzify سوپەرمارکێت",
    nav: { sell: "فرۆشتن", catalog: "بەرهەمەکان", stock: "کۆگا", scan: "سکانکردنی بارکۆد", setup: "ڕێکخستنی دامەزراوە", more: "زیاتر" },
    till: { departments: "بەشەکان: {n}", categoryItems: "{n} کاڵا", open: "کردنەوە" },
  },
  en: {
    productName: "Buzzify Supermarket",
    productWord: "Supermarket",
    loginTitle: "Sign in to Buzzify Supermarket",
    nav: { sell: "Sell", catalog: "Products", stock: "Stock", scan: "Scan a barcode", setup: "Business setup", more: "More" },
    till: { departments: "Departments: {n}", categoryItems: "{n} items", open: "Open" },
  },
});
