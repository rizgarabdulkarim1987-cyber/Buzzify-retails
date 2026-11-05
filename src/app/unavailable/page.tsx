import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { packById } from "@/packs";
import { productBrand } from "@/packs/brand";
import { SHELL_WORDS } from "@/packs/shell-words";
import { getSessionUserId } from "@/server/auth/auth";
import { currentHost } from "../_lib/host";
import { getI18n } from "../_lib/i18n";
import { StateBlock } from "../_ui/state";
import { AuthCard } from "../login/auth-card";
import { signOut } from "../session-actions";

/**
 * Shown on a product address to a signed-in user whose shops all belong to another product that
 * has no address of its own. It names only this address's product, never the other one.
 */
export default async function UnavailablePage() {
  if (!(await getSessionUserId(await headers()))) redirect("/login");
  const { locale, t } = await getI18n();
  const { packId } = await currentHost();
  const pack = packId ? packById(packId) : null;
  const brand = productBrand(pack, locale);
  const w = SHELL_WORDS[locale];
  return (
    <AuthCard locale={locale} t={t} intro={null} product={{ brand, heading: brand.name }}>
      <StateBlock
        kind="locked"
        title={w.unavailableTitle}
        body={w.unavailableBody}
        testId="state-unavailable"
        action={
          <form action={signOut}>
            <button type="submit" className="btn btn-primary" data-testid="unavailable-sign-out">
              {t.common.signOut}
            </button>
          </form>
        }
      />
    </AuthCard>
  );
}
