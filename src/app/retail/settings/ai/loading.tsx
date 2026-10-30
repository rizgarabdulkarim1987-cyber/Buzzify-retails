import { getI18n } from "../../../_lib/i18n";
import { PageSkeleton } from "../../../_ui/page-skeleton";

export default async function Loading() {
  const { t } = await getI18n();
  return <PageSkeleton label={t.common.loading} rows={4} />;
}
