import { getFormatter, getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { tdCls, thCls } from "@/components/ui/form";
import { requireAccountContext } from "@/server/auth/session";
import { accountDb } from "@/server/db/client";
import { listCredentials } from "@/server/security/credentials";
import { CredentialForm } from "./CredentialForm";

export default async function CredentialsPage() {
  const ctx = await requireAccountContext("credentials.write");
  const t = await getTranslations("credentials");
  const format = await getFormatter();
  const rows = await listCredentials(accountDb(ctx.accountId));
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("intro")} />
      <Card>
        {rows.length === 0 ? (
          <p className="mt-0 text-muted">{t("empty")}</p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thCls}>{t("label")}</th>
                <th className={thCls}>{t("secret")}</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className={tdCls}>{c.label}</td>
                  <td className={`${tdCls} font-mono`}>
                    {c.hint}{" "}
                    <span className="ml-2 font-sans text-xs text-muted">
                      {format.dateTime(c.updatedAt, { dateStyle: "medium", timeStyle: "short" })}
                    </span>
                  </td>
                  <td className={tdCls}>
                    <CredentialForm credentialId={c.id} label={c.label} compact />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-4">
          <CredentialForm />
        </div>
      </Card>
    </>
  );
}
