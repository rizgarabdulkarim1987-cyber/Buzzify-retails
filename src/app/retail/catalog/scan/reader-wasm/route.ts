import { readFile } from "node:fs/promises";
import path from "node:path";

/*
 * The zxing-wasm decoder binary, served from this app (the package would otherwise fetch it from a
 * public CDN): decoding stays on the device and no third party is contacted. It is the
 * zxing-wasm/reader build pinned in package.json; the client asks for it with the version in the
 * query, so it can be cached for good. It is a public library file, not shop data.
 */

const FILE = path.join(process.cwd(), "node_modules", "zxing-wasm", "dist", "reader", "zxing_reader.wasm");

let bytes: Promise<Buffer> | null = null;

export async function GET() {
  try {
    bytes ??= readFile(FILE);
    const body = await bytes;
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": "application/wasm",
        "Content-Length": String(body.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    bytes = null;
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}
