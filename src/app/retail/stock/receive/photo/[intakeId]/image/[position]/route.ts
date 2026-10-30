import { getIntakeImage } from "@/server/intake/receipts";
import { isId } from "../../../../../../../_lib/workplace";
import { metaFor } from "../../../../../../catalog/_lib/call";

/*
 * One stored page of a receipt, for the review screen's image. getIntakeImage checks access on
 * every request (switch, cost.view, who may see the intake); the bytes are served with the type the
 * server sniffed at upload, never cached by a shared cache, and never sniffed by the browser.
 */

export const dynamic = "force-dynamic";

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

export async function GET(_req: Request, ctx: { params: Promise<{ intakeId: string; position: string }> }) {
  const { intakeId, position } = await ctx.params;
  const n = Number(position);
  if (!isId(intakeId) || !/^[1-6]$/.test(position)) return new Response(null, { status: 404 });
  const meta = await metaFor("");
  if (!meta) return new Response(null, { status: 403 });
  const read = await getIntakeImage({ intakeId, position: n }, meta);
  if (!read.ok) return new Response(null, { status: read.code === "NOT_FOUND" ? 404 : 403 });
  const type = ALLOWED.has(read.value.contentType) ? read.value.contentType : "application/octet-stream";
  return new Response(new Uint8Array(read.value.bytes), {
    headers: {
      "Content-Type": type,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename="receipt-page-${n}${type === "application/pdf" ? ".pdf" : ""}"`,
    },
  });
}
