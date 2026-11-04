import type { Locale } from "@/messages";

/*
 * Words of the pack shell that belong to no single product: the neutral brand (shown before a
 * business is known on the shared address) and the page shown when a shop opens on another
 * product's address. Kept here, apart from src/messages/*, so the pack work merges cleanly.
 */
export type ShellWords = {
  brand: string;
  /** The product word of the neutral wordmark ("Buzzify Retails"). */
  neutralWord: string;
  unavailableTitle: string;
  unavailableBody: string;
};

export const SHELL_WORDS: Readonly<Record<Locale, ShellWords>> = Object.freeze({
  ar: {
    brand: "Buzzify",
    neutralWord: "Retails",
    unavailableTitle: "متجرك ليس على هذا العنوان",
    unavailableBody: "افتح متجرك من عنوانه الخاص، أو سجّل الخروج وادخل بحساب آخر.",
  },
  ckb: {
    brand: "Buzzify",
    neutralWord: "Retails",
    unavailableTitle: "دوکانەکەت لەسەر ئەم ناونیشانە نییە",
    unavailableBody: "دوکانەکەت لە ناونیشانی خۆیەوە بکەرەوە، یان بچۆ دەرەوە و بە هەژمارێکی تر بچۆ ژوورەوە.",
  },
  en: {
    brand: "Buzzify",
    neutralWord: "Retails",
    unavailableTitle: "Your shop is not on this address",
    unavailableBody: "Open your shop from its own address, or sign out and sign in with another account.",
  },
});
