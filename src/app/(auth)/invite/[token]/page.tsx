import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { acceptAction } from "@/app/actions/invitations";
import { logoutAction } from "@/app/actions/session";
import { getCurrentUser } from "@/server/auth/session";
import { enrolmentForm, findOpenInvitation } from "@/server/invitations";
import { EnrolForm } from "./EnrolForm";

export const dynamic = "force-dynamic";

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-2xl border border-line bg-surface p-6">
        {children}
      </div>
    </main>
  );
}

/**
 * Looks the same whether or not the invited email already has a profile (no enumeration): a visitor who is
 * not signed in sees both "sign in to accept" and "create a profile".
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getTranslations();
  const found = await findOpenInvitation(token);
  if (!found) {
    return (
      <Frame>
        <p className="m-0">{t("invite.invalid")}</p>
      </Frame>
    );
  }
  const { invitation, accountName } = found;
  const role = t(`roles.${invitation.role}`);
  const title = <h1 className="m-0 text-xl font-bold">{t("invite.title", { account: accountName })}</h1>;
  const user = await getCurrentUser();

  if (user) {
    const isInvitee = user.email === invitation.email && found.existingUserId === user.id;
    return (
      <Frame>
        {title}
        <p className="m-0">{t("invite.existingIntro", { account: accountName, role })}</p>
        {isInvitee ? (
          <form action={acceptAction.bind(null, token)}>
            <button type="submit" className="min-h-11 rounded-[10px] bg-accent px-4 font-semibold text-white">
              {t("invite.accept")}
            </button>
          </form>
        ) : (
          <>
            <p className="m-0 text-block">{t("invite.wrongUser", { email: invitation.email })}</p>
            <form action={logoutAction}>
              <button type="submit" className="min-h-11 rounded-[10px] border border-line px-4">
                {t("header.logout")}
              </button>
            </form>
          </>
        )}
      </Frame>
    );
  }

  const form = await enrolmentForm(token);
  return (
    <Frame>
      {title}
      <p className="m-0">{t("invite.existingIntro", { account: accountName, role })}</p>
      <section className="rounded-xl border border-line p-4">
        <p className="mt-0">{t("invite.loginFirst", { email: invitation.email })}</p>
        <Link
          href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
          className="inline-flex min-h-11 items-center rounded-[10px] border border-line px-4 font-semibold no-underline"
        >
          {t("invite.login")}
        </Link>
      </section>
      <section className="flex flex-col gap-3 rounded-xl border border-line p-4">
        <p className="m-0 text-muted">{t("invite.newIntro", { email: invitation.email })}</p>
        <EnrolForm
          token={token}
          secret={form.secret}
          sealed={form.sealed}
          otpauthUri={form.otpauthUri}
          defaultName={form.name ?? ""}
        />
      </section>
    </Frame>
  );
}
