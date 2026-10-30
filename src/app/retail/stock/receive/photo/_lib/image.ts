/*
 * Receipt photos are made smaller in the browser before they are sent (spec 3.12): the longest
 * side at most 1800px, JPEG. The rules (sizes, quality steps, limits) are pure and tested; the
 * canvas work at the bottom runs only in the browser.
 *
 * The limits mirror the server's (src/server/domain/intake.ts, which this file must not import:
 * it pulls node:crypto into the browser bundle); a test keeps them equal. The server checks every
 * file again (count, size, type from the bytes).
 */

/** At most this many pages per receipt (INTAKE_MAX_IMAGES). */
export const MAX_PAGES = 6;
/** One page's bytes as the server takes them (INTAKE_MAX_BYTES). */
export const MAX_PAGE_BYTES = 8 * 1024 * 1024;
/** The longest side of a page sent, in pixels. */
export const MAX_SIDE = 1800;
/**
 * All pages together. They travel base64-encoded in one Server Action (body limit 8 MB in
 * next.config.ts): 5.5 MB of bytes become ~7.3 MB of text, with room for the rest of the request.
 */
export const UPLOAD_BUDGET_BYTES = 5_500_000;
/**
 * A PDF is sent as it is, so it must fit the whole upload on its own: one limit, checked when the
 * file is added (a bigger PDF is refused there with its own message, never later at "read").
 */
export const MAX_PDF_BYTES = UPLOAD_BUDGET_BYTES;
/** What one photo aims at, so six of them fit the budget together. */
export const PAGE_TARGET_BYTES = Math.floor(UPLOAD_BUDGET_BYTES / MAX_PAGES);
/** JPEG qualities tried in turn until the page fits its share. */
export const JPEG_QUALITIES = [0.85, 0.75, 0.65, 0.55] as const;
/**
 * Decoding applies the photo's EXIF orientation, so a portrait phone photo is drawn upright and
 * the JPEG made from the canvas needs no orientation tag.
 */
export const DECODE_OPTIONS = { imageOrientation: "from-image" } as const satisfies ImageBitmapOptions;

/** The size a page is drawn at: the longest side at most `max`, never enlarged, aspect kept. */
export function fitWithin(width: number, height: number, max: number = MAX_SIDE): { width: number; height: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const longest = Math.max(w, h);
  if (longest <= max) return { width: w, height: h };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** The next (lower) quality to try when a page of `size` bytes is over its share, or null to stop. */
export function nextQuality(current: number, size: number, target: number = PAGE_TARGET_BYTES): number | null {
  if (size <= target) return null;
  const i = JPEG_QUALITIES.indexOf(current as (typeof JPEG_QUALITIES)[number]);
  return i >= 0 && i + 1 < JPEG_QUALITIES.length ? JPEG_QUALITIES[i + 1]! : null;
}

/** Images the browser may decode (HEIC only where the browser can), PDFs sent as they are; GIF and the rest refused. */
export function pageKind(type: string, name: string): "image" | "pdf" | null {
  const t = type.toLowerCase();
  if (t === "application/pdf" || (t === "" && /\.pdf$/i.test(name))) return "pdf";
  if (t === "image/gif" || t === "image/svg+xml") return null;
  if (t.startsWith("image/")) return "image";
  return null;
}

/** Whether a PDF of `size` bytes can be sent. */
export function pdfFits(size: number): boolean {
  return size > 0 && size <= MAX_PDF_BYTES;
}

/** How many of `incoming` new files fit beside `current` pages. */
export function roomFor(current: number, incoming: number): { take: number; dropped: number } {
  const take = Math.max(0, Math.min(incoming, MAX_PAGES - current));
  return { take, dropped: incoming - take };
}

export type UploadProblem = "NO_PAGES" | "TOO_MANY" | "TOO_LARGE";

/** Why these pages cannot be sent as they are, or null. */
export function uploadProblem(pages: readonly { size: number }[]): UploadProblem | null {
  if (pages.length === 0) return "NO_PAGES";
  if (pages.length > MAX_PAGES) return "TOO_MANY";
  if (pages.some((p) => p.size <= 0 || p.size > MAX_PAGE_BYTES)) return "TOO_LARGE";
  if (pages.reduce((n, p) => n + p.size, 0) > UPLOAD_BUDGET_BYTES) return "TOO_LARGE";
  return null;
}

/** The payload an upload attempt is tied to: the same pages in the same order keep the idempotency key. */
export function pagesFingerprint(pages: readonly { id: string }[]): string {
  return pages.map((p) => p.id).join("|");
}

// ---------------------------------------------------------------------------------------------
// Browser only

export type PreparedPage = { contentType: "image/jpeg" | "application/pdf"; blob: Blob; width: number | null; height: number | null };

export class PageError extends Error {
  constructor(readonly reason: "UNREADABLE" | "TOO_LARGE" | "PDF_TOO_LARGE") {
    super(reason);
  }
}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, DECODE_OPTIONS);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // Fall through to <img> (it also applies EXIF orientation).
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new PageError("UNREADABLE");
  }
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new PageError("UNREADABLE"))), "image/jpeg", quality));
}

/** One chosen file as the page that is sent: a smaller JPEG, or the PDF itself. */
export async function preparePage(file: File): Promise<PreparedPage> {
  const kind = pageKind(file.type, file.name);
  if (kind === null) throw new PageError("UNREADABLE");
  if (kind === "pdf") {
    if (!pdfFits(file.size)) throw new PageError(file.size <= 0 ? "UNREADABLE" : "PDF_TOO_LARGE");
    return { contentType: "application/pdf", blob: file, width: null, height: null };
  }
  const img = await decode(file);
  try {
    const size = fitWithin(img.width, img.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PageError("UNREADABLE");
    // White under any transparency (a PNG screenshot), as JPEG has none.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(img.source, 0, 0, size.width, size.height);
    let quality: number = JPEG_QUALITIES[0];
    let blob = await toJpeg(canvas, quality);
    for (let next = nextQuality(quality, blob.size); next !== null; next = nextQuality(quality, blob.size)) {
      quality = next;
      blob = await toJpeg(canvas, quality);
    }
    canvas.width = 0;
    canvas.height = 0;
    if (blob.size > MAX_PAGE_BYTES) throw new PageError("TOO_LARGE");
    return { contentType: "image/jpeg", blob, width: size.width, height: size.height };
  } finally {
    img.close();
  }
}

/** A page's bytes as base64 (FileReader data URL without its prefix). */
export function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result);
      resolve(text.slice(text.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}
