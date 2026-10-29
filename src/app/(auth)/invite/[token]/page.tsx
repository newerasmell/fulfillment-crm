import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { acceptAction } from "@/app/actions/invitations";
import { logoutAction } from "@/app/actions/session";
import { getCurrentUser } from "@/server/auth/session";
import { enrolmentSecret, findOpenInvitation } from "@/server/invitations";
import { EnrolForm } from "./EnrolForm";

export const dynamic = "force-dynamic";

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6">{children}</div>
    </main>
  );
}

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
  const { invitation, accountName, existingUserId } = found;
  const title = <h1 className="mt-0 text-xl font-bold">{t("invite.title", { account: accountName })}</h1>;

  if (!existingUserId) {
    const enrol = await enrolmentSecret(token);
    return (
      <Frame>
        {title}
        <p className="text-muted">{t("invite.newIntro", { email: invitation.email })}</p>
        <EnrolForm
          token={token}
          secret={enrol.secret}
          otpauthUri={enrol.otpauthUri}
          defaultName={enrol.name ?? ""}
        />
      </Frame>
    );
  }

  const user = await getCurrentUser();
  const role = t(`roles.${invitation.role}`);
  return (
    <Frame>
      {title}
      <p>{t("invite.existingIntro", { account: accountName, role })}</p>
      {!user && (
        <>
          <p className="text-muted">{t("invite.loginFirst", { email: invitation.email })}</p>
          <Link
            href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
            className="inline-flex min-h-11 items-center rounded-[10px] bg-accent px-4 font-semibold text-white no-underline"
          >
            {t("invite.login")}
          </Link>
        </>
      )}
      {user && user.id === existingUserId && (
        <form action={acceptAction.bind(null, token)}>
          <button type="submit" className="min-h-11 rounded-[10px] bg-accent px-4 font-semibold text-white">
            {t("invite.accept")}
          </button>
        </form>
      )}
      {user && user.id !== existingUserId && (
        <>
          <p className="text-block">{t("invite.wrongUser", { email: invitation.email })}</p>
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
