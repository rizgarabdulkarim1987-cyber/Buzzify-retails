import Link from "next/link";
import { redirect } from "next/navigation";
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

  return (
    <main className="page">
      <div className="page-head">
        <h1>{t.home.title}</h1>
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
