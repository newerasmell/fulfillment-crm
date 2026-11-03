import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { requireAccountContext } from "@/server/auth/session";
import { REPORT_KEYS } from "@/server/reports";

/** Справки (P10-04): landing page with one card per report. */
export default async function ReportsPage() {
  const ctx = await requireAccountContext("reports.read");
  const t = await getTranslations("reports");
  const tn = await getTranslations("nav");
  const company = ctx.companies.find((c) => c.id === ctx.activeCompanyId)?.name ?? tn("allCompanies");
  return (
    <>
      <PageHeader title={t("title")} subtitle={`${t("subtitle")} · ${company}`} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {REPORT_KEYS.map((k) => (
          <Card key={k} className="flex flex-col gap-2">
            <h2 className="m-0 text-lg font-semibold">
              <Link
                href={`/reports/${k}`}
                className="text-ink no-underline hover:underline"
                data-testid={`report-card-${k}`}
              >
                {t(`cards.${k}.title`)}
              </Link>
            </h2>
            <p className="m-0 flex-1 text-sm text-muted">{t(`cards.${k}.text`)}</p>
            <Link href={`/reports/${k}`} className="text-sm text-accent hover:underline">
              {t("open")} →
            </Link>
          </Card>
        ))}
      </div>
      <p className="m-0 text-xs text-muted">{t("vendorHint")}</p>
    </>
  );
}
