import { getTranslations } from "next-intl/server";
import { logoutAction } from "@/app/actions/session";
import { requireUser } from "@/server/auth/session";

export const dynamic = "force-dynamic";

export default async function NoAccessPage() {
  await requireUser();
  const t = await getTranslations();
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6">
        <h1 className="mt-0 text-xl font-bold">{t("noAccess.title")}</h1>
        <p className="text-muted">{t("noAccess.body")}</p>
        <form action={logoutAction}>
          <button type="submit" className="min-h-11 rounded-[10px] border border-line px-4">
            {t("header.logout")}
          </button>
        </form>
      </div>
    </main>
  );
}
