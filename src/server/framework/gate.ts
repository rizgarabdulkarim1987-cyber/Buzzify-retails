/**
 * What a business may do right now. FULL: everything. READ_ONLY: reads only. CLOSED: nothing.
 * Task 6 fills gateOf from the business's subscription/status; until then everything is allowed.
 */
export type GateMode = "FULL" | "READ_ONLY" | "CLOSED";

export async function gateOf(businessId: string, client: unknown): Promise<GateMode> {
  void businessId;
  void client;
  return "FULL";
}
