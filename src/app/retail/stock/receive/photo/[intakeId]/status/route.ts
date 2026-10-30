import { getIntake } from "@/server/intake/receipts";
import { isId } from "../../../../../../_lib/workplace";
import { metaFor } from "../../../../../catalog/_lib/call";

/*
 * The reading screen's status check. A Route Handler, not a Server Action: the client sends Server
 * Actions one at a time, so a check would wait behind the read it is watching. The answer carries
 * the status and failure code only (no price); getIntake checks access (switch, cost.view, who may
 * see the intake) and sweeps a read whose lease ran out.
 */

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function GET(_req: Request, ctx: { params: Promise<{ intakeId: string }> }) {
  const { intakeId } = await ctx.params;
  if (!isId(intakeId)) return json({ ok: false, code: "NOT_FOUND" }, 404);
  const meta = await metaFor("");
  if (!meta) return json({ ok: false, code: "FORBIDDEN" }, 403);
  const read = await getIntake({ intakeId }, meta);
  if (!read.ok) return json({ ok: false, code: read.code }, read.code === "NOT_FOUND" ? 404 : 403);
  return json({ ok: true, status: read.value.status, failureCode: read.value.failureCode });
}
