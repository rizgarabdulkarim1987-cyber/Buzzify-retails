import Link from "next/link";
import type { Messages } from "@/messages";
import type { ErrorCode } from "@/server/framework/errors";
import { StateBlock } from "../../../_ui/state";

/** The page body when the business refuses the user: closed / archived, or not a member. */
export function RefusedPage({ code, t }: { code: ErrorCode; t: Messages }) {
  return (
    <main className="page">
      {code === "READ_ONLY" ? (
        <StateBlock kind="alert" title={t.access.closedTitle} body={t.access.closedBody} testId="state-closed" />
      ) : (
        <StateBlock
          kind="locked"
          title={t.access.noPermissionTitle}
          body={t.access.noPermissionBody}
          testId="state-forbidden"
          action={
            <Link href="/retail/home" className="btn btn-secondary">
              {t.setup.backToHome}
            </Link>
          }
        />
      )}
    </main>
  );
}
