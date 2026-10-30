import { getIntakeImage } from "@/server/intake/receipts";
import { isId } from "../../../../../../../_lib/workplace";
import { metaFor } from "../../../../../../catalog/_lib/call";

/*
 * One stored page of a receipt, for the review screen's image. getIntakeImage checks access on
 * every request (switch, cost.view, who may see the intake). A supplier receipt carries prices, so
 * it is never stored by any cache, the browser's included (a shared terminal must not show it to
 * the next user from its cache); it is served with the type the server sniffed at upload, never
 * sniffed by the browser. An image is sandboxed when opened on its own (no script runs in it); a
 * PDF is not, as the browser’s PDF viewer needs scripts to show it (nosniff and the sniffed type
 * keep it a PDF).
 */

export const dynamic = "force-dynamic";

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const BASE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } as const;
const SANDBOX = { "Content-Security-Policy": "sandbox" } as const;

type Ctx = { params: Promise<{ intakeId: string; position: string }> };

const refuse = (status: number) => new Response(null, { status, headers: { ...BASE, ...SANDBOX } });

async function page(ctx: Ctx, withBody: boolean): Promise<Response> {
  const { intakeId, position } = await ctx.params;
  const n = Number(position);
  if (!isId(intakeId) || !/^[1-6]$/.test(position)) return refuse(404);
  const meta = await metaFor("");
  if (!meta) return refuse(403);
  const read = await getIntakeImage({ intakeId, position: n }, meta);
  if (!read.ok) return refuse(read.code === "NOT_FOUND" ? 404 : 403);
  const type = ALLOWED.has(read.value.contentType) ? read.value.contentType : "application/octet-stream";
  return new Response(withBody ? new Uint8Array(read.value.bytes) : null, {
    headers: {
      ...BASE,
      ...(type === "application/pdf" ? {} : SANDBOX),
      "Content-Type": type,
      "Content-Length": String(read.value.bytes.byteLength),
      "Content-Disposition": `inline; filename="receipt-page-${n}${type === "application/pdf" ? ".pdf" : ""}"`,
    },
  });
}

export async function GET(_req: Request, ctx: Ctx) {
  return page(ctx, true);
}

/** The same answer without the bytes: the viewer asks it to tell a PDF page from a broken image. */
export async function HEAD(_req: Request, ctx: Ctx) {
  return page(ctx, false);
}
