import { z } from "zod";
import type { RtRole } from "@/generated/prisma/client";
import { defineAction } from "@/server/framework/action";

/*
 * What the retail shell shows and lets the user pick: the business's name and the branches (with
 * their terminals) the actor may work in. A read action, so it runs through the scoped client:
 * a branch-limited actor (a cashier of branch A) gets only their own branches and terminals, a
 * deactivated member or a stranger gets FORBIDDEN, and a CLOSED business gets READ_ONLY.
 */

export type ShellTerminal = { id: string; name: string };
export type ShellBranch = { id: string; name: string; terminals: ShellTerminal[] };
export type ShellOptions = {
  business: { id: string; name: string };
  role: RtRole;
  branches: ShellBranch[];
};

export const shellOptions = defineAction({
  name: "shell.options",
  permission: null,
  input: z.object({}),
  writes: false,
  async run({ actor, tx }): Promise<ShellOptions> {
    const business = await tx.rtBusiness.findFirstOrThrow({ select: { id: true, name: true } });
    const branches = await tx.rtBranch.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    // Terminals are branch-scoped, so they are read on their own (not as a relation of the branch).
    const terminals = await tx.rtTerminal.findMany({
      where: { active: true, branchId: { in: branches.map((b) => b.id) } },
      select: { id: true, name: true, branchId: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    return {
      business,
      role: actor.role,
      branches: branches.map((b) => ({
        ...b,
        terminals: terminals.filter((t) => t.branchId === b.id).map(({ id, name }) => ({ id, name })),
      })),
    };
  },
});
