import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@/server/domain/permissions";
import { getI18n } from "../../_lib/i18n";
import { StateBlock } from "../../_ui/state";
import { requireShell } from "../_shell";

export default async function RetailHomePage() {
  const shell = await requireShell();
  const { t } = await getI18n();

  // A business that refuses this user (deactivated, closed) is shown here, not bounced around.
  if (shell.options && !shell.options.ok) {
    return (
      <main className="page">
        {shell.options.code === "READ_ONLY" ? (
          <StateBlock kind="alert" title={t.access.closedTitle} body={t.access.closedBody} testId="state-closed" />
        ) : (
          <StateBlock kind="locked" title={t.access.noPermissionTitle} body={t.access.noPermissionBody} testId="state-forbidden" />
        )}
      </main>
    );
  }
  if (!shell.branch) redirect("/retail/select");
  const canSetUp = shell.options?.ok === true && can(shell.options.value.role, "staff.manage");

  return (
    <main className="page">
      <div className="page-head">
        <div className="title-row">
          <h1>{t.home.title}</h1>
          {canSetUp ? (
            <Link href="/retail/setup" className="btn btn-secondary" data-testid="open-setup" style={{ marginInlineStart: "auto" }}>
              {t.setup.openFromHome}
            </Link>
          ) : null}
        </div>
      </div>
      <StateBlock
        kind="empty"
        title={t.home.emptyTitle}
        body={t.home.emptyBody}
        testId="state-home-empty"
        action={
          <Link href="/retail/select" className="btn btn-secondary">
            {t.header.switchBranch}
          </Link>
        }
      />
    </main>
  );
}
