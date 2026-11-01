import Link from "next/link";
import { can } from "@/server/domain/permissions";
import { businessToday } from "@/server/domain/stock";
import type { ActionMeta } from "@/server/framework/action";
import { DEFAULT_TIMEZONE } from "@/server/setup/progress";
import { listStockDocuments } from "@/server/stock/documents";
import { getI18n } from "../../../_lib/i18n";
import { isId } from "../../../_lib/workplace";
import { StateBlock } from "../../../_ui/state";
import { RefusedPage } from "../../catalog/_lib/state-pages";
import { loadStockAccess } from "../_lib/access";
import { loadReceiptDraft } from "../_lib/receipt-load";
import { rateText, receiptFailureMessage, receiveHref, type ReceiptKind, type ReceiptSettings } from "../_lib/receipt-rules";
import { DraftList, ReceiptDone, type DraftRowDto } from "../_lib/receipt-views";
import { businessTimezone } from "../_lib/stock-reads";
import { ReadOnlyBanner } from "../_lib/views";
import { postedSummaryAction } from "./actions";
import { loadAiStatus, photoRole } from "./photo/_lib/load";
import { photoLink } from "./photo/_lib/rules";
import { ReceiptForm } from "./receipt-form";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** The business's day (its own time zone) for the screen's expiry hints; the server decides when posting. */
async function todayText(meta: ActionMeta): Promise<string> {
  const tz = await businessTimezone({}, meta);
  try {
    return businessToday(new Date(), tz.ok ? tz.value : DEFAULT_TIMEZONE).toISOString().slice(0, 10);
  } catch {
    return businessToday(new Date(), DEFAULT_TIMEZONE).toISOString().slice(0, 10);
  }
}

/** Open drafts are found by paging the newest documents of each kind, a bounded number of pages. */
const DRAFT_PAGE = 50;
const DRAFT_PAGES = 4;
const DRAFTS_SHOWN = 10;

/**
 * Receiving goods (RECEIPT) or entering opening stock (OPENING, ?kind=opening). ?draft=id reopens a
 * saved draft (the form writes it into the link after the first save, so a reload lands here).
 */
export default async function ReceivePage({ searchParams }: { searchParams: SearchParams }) {
  const { locale, t } = await getI18n();
  const access = await loadStockAccess();
  if (!access.ok) return <RefusedPage code={access.code} t={t} />;
  const ctx = access.context;
  const r = t.stock.receive;
  const params = await searchParams;
  const fromSetup = one(params.from) === "setup";
  const extra = fromSetup ? "from=setup" : "";
  const back = (
    <Link href={fromSetup ? "/retail/setup" : "/retail/stock"} className="btn btn-secondary" data-testid="receipt-back">
      {fromSetup ? r.backToSetup : r.back}
    </Link>
  );

  if (!ctx.canReceive) {
    return (
      <main className="page">
        <StateBlock kind="locked" title={r.noPermissionTitle} body={r.noPermissionBody} testId="state-forbidden" action={back} />
      </main>
    );
  }

  const settings: ReceiptSettings = {
    defaultCurrency: ctx.defaultCurrency,
    enabledCurrencies: ctx.enabledCurrencies,
    lastRate: ctx.lastRateMicro ? rateText(ctx.lastRateMicro) : "",
  };
  const draftId = one(params.draft);
  let kind: ReceiptKind = one(params.kind) === "opening" ? "OPENING" : "RECEIPT";

  const missing = (
    <main className="page">
      <StateBlock
        kind="alert"
        title={t.errors.NOT_FOUND}
        body={r.notFound}
        testId="state-not-found"
        action={
          <Link href={receiveHref({ kind }, extra)} className="btn btn-secondary">
            {r.newDocument}
          </Link>
        }
      />
    </main>
  );

  let initial: Awaited<ReturnType<typeof loadReceiptDraft>> | null = null;
  if (draftId !== "") {
    if (!isId(draftId)) return missing;
    initial = await loadReceiptDraft(draftId, access.meta);
    if (!initial.ok) {
      if (initial.code === "NOT_FOUND") return missing;
      return (
        <main className="page">
          <StateBlock kind="alert" title={t.common.errorTitle} body={receiptFailureMessage(t, initial, locale)} testId="state-error" action={back} />
        </main>
      );
    }
    kind = initial.value.doc.kind === "OPENING" ? "OPENING" : "RECEIPT";
    if (initial.value.doc.status === "POSTED") {
      const summary = await postedSummaryAction(draftId);
      if (!summary.ok) return missing;
      return (
        <main className="page page-narrow">
          <div className="page-head">
            <div className="title-row">
              <h1>{kind === "OPENING" ? r.titleOPENING : r.titleRECEIPT}</h1>
              {back}
            </div>
          </div>
          <ReceiptDone locale={locale} t={t} currency={settings.defaultCurrency} done={summary.value} alreadyPosted newHref={receiveHref({ kind }, extra)} />
        </main>
      );
    }
  }

  // The open drafts to continue (only on a new document's screen).
  let drafts: DraftRowDto[] = [];
  if (!initial) {
    for (const k of ["RECEIPT", "OPENING"] as const) {
      let cursor: string | undefined;
      let found = 0;
      for (let p = 0; p < DRAFT_PAGES && found < DRAFTS_SHOWN; p += 1) {
        const list = await listStockDocuments({ kind: k, limit: DRAFT_PAGE, ...(cursor ? { cursor } : {}) }, access.meta);
        if (!list.ok) break;
        for (const d of list.value.rows) {
          if (d.status !== "DRAFT") continue;
          found += 1;
          drafts.push({ id: d.id, kind: k, lineCount: d.lineCount, createdAt: d.createdAt.toISOString() });
        }
        if (!list.value.nextCursor) break;
        cursor = list.value.nextCursor;
      }
    }
    drafts = drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, DRAFTS_SHOWN);
  }

  // "From a receipt photo" (R1b): only on a new receipt, for a role that may use it, while the
  // ai.intake switch is on; with it off the owner sees one line saying so, everyone else nothing.
  const role = photoRole(ctx.role);
  const photo = !initial && kind === "RECEIPT" && role.canUseAi && role.canReceive && role.seesCost ? photoLink(role, await loadAiStatus(access.meta)) : "HIDE";

  return (
    <main className="page">
      <div className="page-head">
        <div className="title-row">
          <h1>{kind === "OPENING" ? r.titleOPENING : r.titleRECEIPT}</h1>
          <div className="title-actions">
            {photo === "SHOW" ? (
              <Link href="/retail/stock/receive/photo" className="btn btn-primary" data-testid="receipt-photo-link">
                {t.stock.intake.fromPhoto}
              </Link>
            ) : null}
            {kind === "OPENING" && can(ctx.role, "catalog.import") ? (
              <Link href={`/retail/stock/import${fromSetup ? "?from=setup" : ""}`} className="btn btn-secondary" data-testid="receipt-import-link">
                {r.importFile}
              </Link>
            ) : null}
            {back}
          </div>
        </div>
        <p>{kind === "OPENING" ? r.introOPENING : r.introRECEIPT}</p>
        {photo === "OWNER_HINT" ? (
          <p className="hint" data-testid="receipt-photo-disabled">
            {t.stock.intake.disabledHint}
          </p>
        ) : null}
      </div>
      {access.readOnly ? <ReadOnlyBanner t={t} /> : null}
      <DraftList locale={locale} t={t} drafts={drafts} query={extra} />
      <ReceiptForm
        key={initial?.ok ? `${initial.value.doc.id}:${initial.value.doc.version}` : `new:${kind}`}
        locale={locale}
        t={t}
        settings={settings}
        today={await todayText(access.meta)}
        readOnly={access.readOnly}
        kind={kind}
        initial={initial?.ok ? initial.value : null}
        query={extra}
      />
    </main>
  );
}
