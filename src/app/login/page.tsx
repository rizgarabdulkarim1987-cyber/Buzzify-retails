import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/server/admin/platform-admin";
import { getSessionUserId } from "@/server/auth/auth";
import { studioSignInHref } from "@/server/core/handoff";
import { packById, packWords } from "@/packs";
import { productBrand } from "@/packs/brand";
import { currentHost } from "../_lib/host";
import { getI18n } from "../_lib/i18n";
import { AuthCard } from "./auth-card";
import { LoginForm } from "./login-form";

/** The public sign-in: one "Sign in" button (the handoff), or the password form when there is none. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const { error } = await searchParams;
  const userId = await getSessionUserId(await headers());
  if (userId) redirect((await isPlatformAdmin(userId)) ? "/admin" : "/retail/home");
  const { locale, t } = await getI18n();
  const handoffHref = studioSignInHref();
  // On a product address the card names that product; the shared address stays neutral.
  const { packId } = await currentHost();
  const pack = packId ? packById(packId) : null;
  const product = pack ? { brand: productBrand(pack, locale), heading: packWords(pack, locale).loginTitle } : undefined;
  return (
    <AuthCard locale={locale} t={t} intro={handoffHref ? null : t.auth.intro} product={product}>
      <LoginForm
        labels={{
          email: t.auth.email,
          password: t.auth.password,
          submit: t.auth.submit,
          failed: t.auth.failed,
          throttled: t.auth.throttled,
          loading: t.common.loading,
          signIn: t.auth.signIn,
          coreFailed: t.auth.coreFailed,
        }}
        handoffHref={handoffHref}
        coreError={error === "core"}
      />
    </AuthCard>
  );
}
