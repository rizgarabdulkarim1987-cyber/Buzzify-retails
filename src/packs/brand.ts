import type { Locale } from "@/messages";
import { packWords, type PackManifest } from "./index";
import { SHELL_WORDS } from "./shell-words";

export type ProductBrand = {
  /** "Buzzify", in Latin letters in every locale. */
  brand: string;
  /** The product word in the UI language ("Supermarket"), or the neutral "Retails". */
  word: string;
  /** The full name for titles and headings. */
  name: string;
};

/** What the wordmark and the page titles show for this pack (null = the neutral shared address). */
export function productBrand(pack: PackManifest | null, locale: Locale): ProductBrand {
  const shell = SHELL_WORDS[locale];
  if (!pack) return { brand: shell.brand, word: shell.neutralWord, name: `${shell.brand} ${shell.neutralWord}` };
  const w = packWords(pack, locale);
  return { brand: shell.brand, word: w.productWord, name: w.productName };
}
