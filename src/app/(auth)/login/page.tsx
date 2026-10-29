import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/server/auth/session";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  const t = await getTranslations("login");
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6">
        <div className="mb-5 flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex size-8 items-center justify-center rounded-lg bg-dark font-bold text-white"
          >
            F
          </span>
          <span className="font-bold">Fulfillment CRM</span>
        </div>
        <h1 className="mt-0 mb-4 text-xl font-bold">{t("title")}</h1>
        <LoginForm />
      </div>
    </main>
  );
}
