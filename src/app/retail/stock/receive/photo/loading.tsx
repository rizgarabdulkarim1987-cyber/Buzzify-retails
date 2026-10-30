import { getI18n } from "../../../../_lib/i18n";
import { StockSkeleton } from "../../_lib/views";

export default async function Loading() {
  const { t } = await getI18n();
  return <StockSkeleton label={t.common.loading} />;
}
