import type { Locale } from "@/messages";
import type { PackWords } from "../types";

/** Buzzify Electronics' own words. The brand "Buzzify" stays in Latin letters in every locale. */
export const electronicsWords: Readonly<Record<Locale, PackWords>> = Object.freeze({
  ar: {
    productName: "Buzzify إلكترونيات",
    productWord: "إلكترونيات",
    loginTitle: "الدخول إلى Buzzify إلكترونيات",
    nav: { sell: "البيع", catalog: "الأجهزة", stock: "المخزون", scan: "مسح باركود", setup: "إعداد المنشأة", more: "المزيد" },
    till: { departments: "الفئات: {n}", categoryItems: "{n} منتج", open: "تصفح" },
  },
  ckb: {
    productName: "Buzzify ئەلیکترۆنیات",
    productWord: "ئەلیکترۆنیات",
    loginTitle: "چوونەژوورەوە بۆ Buzzify ئەلیکترۆنیات",
    nav: { sell: "فرۆشتن", catalog: "ئامێرەکان", stock: "کۆگا", scan: "سکانکردنی بارکۆد", setup: "ڕێکخستنی دامەزراوە", more: "زیاتر" },
    till: { departments: "پۆلەکان: {n}", categoryItems: "{n} بەرهەم", open: "بینین" },
  },
  en: {
    productName: "Buzzify Electronics",
    productWord: "Electronics",
    loginTitle: "Sign in to Buzzify Electronics",
    nav: { sell: "Sell", catalog: "Devices", stock: "Stock", scan: "Scan a barcode", setup: "Business setup", more: "More" },
    till: { departments: "Categories: {n}", categoryItems: "{n} products", open: "Browse" },
  },
});
