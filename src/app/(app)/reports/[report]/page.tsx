import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireAccountContext } from "@/server/auth/session";
import { can } from "@/server/auth/rbac";
import { isReportKey, parseRange } from "@/server/reports";
import { reportCtxOf } from "../context";
import { RangeBar } from "../ui";
import { CodView, OrdersView, ReviewView, ShipmentsView, StockView, TimingView } from "./views";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ report: string }>;
  searchParams: Promise<Search>;
}) {
  const { report } = await params;
  if (!isReportKey(report)) notFound();
  const ctx = await requireAccountContext("reports.read");
  if (report === "cod" && !can(ctx.role, "cod.read")) notFound();
  const sp = await searchParams;
  const range = parseRange({ from: one(sp.from), to: one(sp.to), preset: one(sp.preset) });
  const { rc, scope } = await reportCtxOf(ctx);
  const t = await getTranslations("reports");
  const tn = await getTranslations("nav");
  const company = ctx.companies.find((c) => c.id === ctx.activeCompanyId)?.name ?? tn("allCompanies");
  const warehouse = scope === "all" ? t("scopeAll") : scope === "eu" ? "euShipments" : "FHB";
  const View = {
    orders: OrdersView,
    shipments: ShipmentsView,
    timing: TimingView,
    cod: CodView,
    review: ReviewView,
    stock: StockView,
  }[report];
  return (
    <>
      <div className="flex flex-col gap-1">
        <Link href="/reports" className="text-sm text-accent hover:underline">
          ← {t("back")}
        </Link>
        <PageHeader title={t(`cards.${report}.title`)} subtitle={t("scope", { company, warehouse })} />
      </div>
      {report === "stock" ? (
        <div className="flex justify-end">
          <a
            href={`/api/reports/stock/export`}
            className="inline-flex min-h-10 items-center rounded-[10px] border border-line bg-surface px-3 no-underline hover:bg-hover"
            data-testid="report-export"
          >
            {t("export")}
          </a>
        </div>
      ) : (
        <RangeBar report={report} range={range} preset={range.preset} />
      )}
      <View ctx={rc} range={range} />
    </>
  );
}
