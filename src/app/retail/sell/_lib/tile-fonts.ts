import { Geist_Mono, Space_Grotesk } from "next/font/google";

/*
 * The category tiles' own type: Space Grotesk for Latin names and digits, Geist Mono for the small
 * labels. Latin subset only, swapped in when loaded (Arabic and Kurdish names use the project's
 * system Arabic stack, which Space Grotesk has no glyphs for). Self-hosted by next/font at build.
 */
export const grotesk = Space_Grotesk({ subsets: ["latin"], display: "swap", weight: ["600", "700"], variable: "--font-grotesk" });
export const mono = Geist_Mono({ subsets: ["latin"], display: "swap", weight: ["500"], variable: "--font-tile-mono" });
