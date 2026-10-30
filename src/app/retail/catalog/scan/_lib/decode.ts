import { DECODE_FORMATS } from "./rules";

/*
 * Barcode decoding on the device (spec 3.7): the browser's BarcodeDetector where it exists, else
 * zxing-wasm (loaded only then, its wasm served by this app: reader-wasm/route.ts). Browser only.
 * Nothing leaves the device here; only the code found is looked up.
 */

type DetectorLike = { detect(source: ImageBitmapSource): Promise<{ rawValue: string }[]> };
type DetectorClass = {
  new (options: { formats: string[] }): DetectorLike;
  getSupportedFormats(): Promise<string[]>;
};

export type Decoder = {
  kind: "detector" | "zxing";
  /** A frame of the live camera. */
  frame(video: HTMLVideoElement): Promise<string | null>;
  /** A still photo. */
  still(blob: Blob): Promise<string | null>;
};

/** The wasm's address on this app; the version in the query lets it be cached for good. */
export const READER_WASM_PATH = "/retail/catalog/scan/reader-wasm";

/** Frames are drawn at most this wide for zxing (enough for a barcode, cheap on a phone). */
const FRAME_WIDTH = 960;

let zxing: Promise<typeof import("zxing-wasm/reader")> | null = null;

function loadZxing() {
  zxing ??= (async () => {
    const mod = await import("zxing-wasm/reader");
    await mod.prepareZXingModule({
      overrides: {
        locateFile: (file: string, prefix: string) => (file.endsWith(".wasm") ? `${READER_WASM_PATH}?v=${mod.ZXING_WASM_VERSION}` : prefix + file),
      },
      fireImmediately: true,
    });
    return mod;
  })().catch((err: unknown) => {
    zxing = null; // a later attempt may load it
    throw err;
  });
  return zxing;
}

async function detectorDecoder(): Promise<Decoder | null> {
  const Detector = (globalThis as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
  if (!Detector) return null;
  try {
    const supported = await Detector.getSupportedFormats();
    const formats = DECODE_FORMATS.detector.filter((f) => supported.includes(f));
    if (!formats.some((f) => f.startsWith("ean_") || f.startsWith("upc_"))) return null;
    const detector = new Detector({ formats });
    const first = async (source: ImageBitmapSource) => (await detector.detect(source))[0]?.rawValue ?? null;
    return {
      kind: "detector",
      frame: (video) => first(video),
      still: async (blob) => {
        const bmp = await createImageBitmap(blob);
        try {
          return await first(bmp);
        } finally {
          bmp.close();
        }
      },
    };
  } catch {
    return null;
  }
}

async function zxingDecoder(): Promise<Decoder> {
  const z = await loadZxing();
  const options = { formats: [...DECODE_FORMATS.zxing], tryHarder: true, maxNumberOfSymbols: 1 };
  const canvas = document.createElement("canvas");
  const first = (results: { text: string; isValid: boolean }[]) => results.find((r) => r.isValid && r.text !== "")?.text ?? null;
  return {
    kind: "zxing",
    frame: async (video) => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w === 0 || h === 0) return null;
      const scale = Math.min(1, FRAME_WIDTH / w);
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return first(await z.readBarcodes(ctx.getImageData(0, 0, canvas.width, canvas.height), options));
    },
    // Drawn by the browser (which applies EXIF and knows every format it shows), read as pixels.
    still: async (blob) => {
      const bmp = await createImageBitmap(blob);
      try {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(bmp, 0, 0);
        return first(await z.readBarcodes(ctx.getImageData(0, 0, canvas.width, canvas.height), options));
      } finally {
        bmp.close();
      }
    },
  };
}

/** The decoder this browser can use: BarcodeDetector (with the retail formats), else zxing-wasm. */
export async function createDecoder(): Promise<Decoder> {
  return (await detectorDecoder()) ?? (await zxingDecoder());
}

/** One frame of the live camera as a JPEG (the photo kept for the AI fallback), its longest side at most `max`. */
export function captureFrame(video: HTMLVideoElement, max: number): Promise<Blob | null> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w === 0 || h === 0) return Promise.resolve(null);
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85));
}

/** Stops every track of a camera stream (the light goes off). */
export function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}
