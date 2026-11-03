import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { FillWeightsButton } from "@/components/rules-weights/WeightForm";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { LineChip } from "@/components/ui/LineChip";
import { ghostButtonCls, tdCls, thCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { accountDb } from "@/server/db/client";
import { listCatalogueRuns } from "@/server/lines/catalogue";
import { lineCoverage } from "@/server/lines/coverage";
import { lineMembers } from "@/server/lines/lines";
import { listSuggestions } from "@/server/lines/suggestions";
import { CoverageSummary } from "./coverage";
import { AutoRefresh, ImportForm, StartCatalogueForm, SuggestionActions } from "./forms";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

/**
 * Продукти → Основни продукти по линии (P5-00): master catalogue tool, coverage, match suggestions and the
 * Excel/CSV mapping of one product line.
 */
export default async function ProductLinesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const ctx = await requireAccountContext();
  const t = await getTranslations("lines");
  const format = await getFormatter();
  const requested = one(sp.line);
  const line =
    ctx.lines.find((l) => l.id === requested) ??
    ctx.lines.find((l) => l.id === ctx.activeLineId) ??
    ctx.lines[0];
  if (!line) {
    return (
      <>
        <PageHeader title={t("toolTitle")} subtitle={t("toolIntro")} />
        <Card>
          <p className="m-0 text-muted">
            {can(ctx.role, "lines.manage") ? t("noLinesAdmin") : t("noLinesMember")}{" "}
            {can(ctx.role, "lines.manage") && (
              <Link href="/settings/lines" className="text-accent">
                {t("settingsTitle")}
              </Link>
            )}
          </p>
        </Card>
      </>
    );
  }
  const actor = actorFrom(ctx);
  const page = Math.max(1, Number(one(sp.page)) || 1);
  // Restricted members see only their own companies' warehouses and stores of the line.
  const members = await lineMembers(ctx.accountId, line.id, ctx.companyScope);
  const myConnections = members.connections;
  const counts = myConnections.length
    ? await accountDb(ctx.accountId).vendorProduct.groupBy({
        by: ["connectionId"],
        where: { connectionId: { in: myConnections.map((c) => c.id) }, archived: false },
        _count: { _all: true },
      })
    : [];
  const countOf = new Map(counts.map((c) => [c.connectionId, c._count._all]));
  const [coverage, runs, suggestions] = await Promise.all([
    lineCoverage(ctx.accountId, line.id, ctx.companyScope),
    listCatalogueRuns(ctx.accountId, line.id, { scope: ctx.companyScope }),
    listSuggestions(actor, line.id, page),
  ]);
  const running = runs.some((r) => r.status === "QUEUED" || r.status === "RUNNING");
  const mayWork = can(ctx.role, "lines.catalogue");
  const mayMatch = can(ctx.role, "products.match");
  return (
    <>
      <AutoRefresh active={running} />
      <PageHeader
        title={t("toolTitle")}
        subtitle={t("toolIntro")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {can(ctx.role, "products.weight") && <FillWeightsButton />}
            <Link href="/products" className={`${ghostButtonCls} inline-flex items-center`}>
              {t("backToProducts")}
            </Link>
          </div>
        }
      />
      {ctx.lines.length > 1 && (
        <nav aria-label={t("lines")} className="flex flex-wrap gap-2">
          {ctx.lines.map((l) => (
            <Link
              key={l.id}
              href={`/products/lines?line=${l.id}`}
              aria-current={l.id === line.id ? "page" : undefined}
              className={`rounded-full no-underline ${l.id === line.id ? "ring-2 ring-accent" : ""}`}
            >
              <LineChip name={l.name} color={l.color} className="min-h-8 px-3 text-sm" />
            </Link>
          ))}
        </nav>
      )}
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <LineChip name={line.name} color={line.color} />
          <h2 className="m-0 text-base font-semibold">{t("coverage")}</h2>
        </div>
        <CoverageSummary coverage={coverage} detailed />
      </Card>

      {mayWork && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("catalogueTitle")}</h2>
          <p className="mt-0 text-[13px] text-muted">{t("catalogueIntro")}</p>
          {myConnections.length === 0 ? (
            <p className="m-0 text-muted">{t("noWarehouses")}</p>
          ) : (
            <StartCatalogueForm
              lineId={line.id}
              connections={myConnections.map((c) => ({
                id: c.id,
                name: c.name,
                type: c.type,
                count: countOf.get(c.id) ?? 0,
              }))}
            />
          )}
          {runs.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full border-collapse" aria-label={t("runs")}>
                <thead>
                  <tr>
                    <th className={thCls}>{t("runStarted")}</th>
                    <th className={thCls}>{t("warehouse")}</th>
                    <th className={thCls}>{t("runStatus")}</th>
                    <th className={thCls}>{t("runProgress")}</th>
                    <th className={thCls}>{t("runResult")}</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} data-testid="catalogue-run">
                      <td className={`${tdCls} text-muted`}>
                        {format.dateTime(r.createdAt, { dateStyle: "short", timeStyle: "short" })}
                      </td>
                      <td className={tdCls}>{r.connection.name}</td>
                      <td className={tdCls}>{t(`runStatuses.${r.status}`)}</td>
                      <td className={`${tdCls} min-w-40`}>
                        <div className="flex items-center gap-2">
                          <progress
                            max={Math.max(1, r.total)}
                            value={Math.min(r.processed, r.total)}
                            aria-label={t("runProgress")}
                            className="h-2 w-28"
                          />
                          <span className="font-mono text-[13px]">
                            {r.processed}/{r.total}
                          </span>
                        </div>
                      </td>
                      <td className={`${tdCls} text-[13px]`}>
                        {t("runSummary", {
                          created: r.created,
                          linked: r.linked,
                          adopted: r.adopted,
                          autoLinked: r.autoLinked,
                          conflicts: r.conflicts,
                        })}
                        {r.conflicts > 0 && Array.isArray(r.conflictSamples) && (
                          <span className="block font-mono text-muted">
                            {t("conflictSamples", { skus: (r.conflictSamples as string[]).join(", ") })}
                          </span>
                        )}
                        {r.status === "FAILED" && <span className="block text-block">{t("runFailed")}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {mayWork && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("mappingTitle")}</h2>
          <p className="mt-0 text-[13px] text-muted">{t("mappingIntro")}</p>
          <div className="mb-4 flex flex-wrap gap-2">
            <a
              href={`/api/lines/${line.id}/mapping?format=xlsx`}
              className={`${ghostButtonCls} inline-flex items-center`}
            >
              {t("exportXlsx")}
            </a>
            <a
              href={`/api/lines/${line.id}/mapping?format=csv`}
              className={`${ghostButtonCls} inline-flex items-center`}
            >
              {t("exportCsv")}
            </a>
          </div>
          <ImportForm lineId={line.id} />
        </Card>
      )}

      <Card>
        <h2 className="mt-0 text-base font-semibold">
          {t("suggestionsTitle", { count: suggestions.total })}
        </h2>
        <p className="mt-0 text-[13px] text-muted">{t("suggestionsIntro")}</p>
        {suggestions.items.length === 0 ? (
          <p className="m-0 text-muted">{t("suggestionsEmpty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>{t("source")}</th>
                  <th className={thCls}>{t("item")}</th>
                  <th className={thCls}>{t("suggestion")}</th>
                  {mayMatch && <th className={thCls} />}
                </tr>
              </thead>
              <tbody>
                {suggestions.items.map((i) => {
                  const best = i.candidates[0] ?? null;
                  return (
                    <tr key={`${i.kind}:${i.id}`} data-testid={`suggestion-${i.code}`}>
                      <td className={tdCls}>
                        <span className="flex items-center gap-2">
                          <span
                            aria-hidden
                            className={`size-2 rounded-full ${i.sourceType === "FHB_V3" ? "bg-fhb" : i.sourceType === "EUSHIPMENTS" ? "bg-eu" : "bg-muted"}`}
                          />
                          {i.source}
                        </span>
                      </td>
                      <td className={tdCls}>
                        <span className="block">{i.name}</span>
                        <span className="font-mono text-[12px] text-muted">
                          {i.code}
                          {i.barcode ? ` · ${t("barcodeHint", { code: i.barcode })}` : ""}
                        </span>
                      </td>
                      <td className={tdCls}>
                        {best ? (
                          <div className="flex flex-col gap-0.5">
                            <span>
                              <span className="font-mono">{best.sku}</span> · {best.name}
                            </span>
                            <span className="flex flex-wrap items-center gap-1.5 text-[12px]">
                              <span
                                className={`rounded-full px-2 py-0.5 font-mono font-semibold ${best.score >= 1 ? "bg-ok-bg text-ok" : best.score >= 0.7 ? "bg-accent-soft text-accent-strong" : "bg-warn-bg text-warn"}`}
                              >
                                {t("confidence", { pct: Math.round(best.score * 100) })}
                              </span>
                              {best.reasons.map((r) => (
                                <span key={r.kind} className="text-muted">
                                  {r.kind === "name"
                                    ? t("reason.name", { pct: Math.round((r.value ?? 0) * 100) })
                                    : t(`reason.${r.kind}`)}
                                </span>
                              ))}
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted">{t("noSuggestion")}</span>
                        )}
                      </td>
                      {mayMatch && (
                        <td className={tdCls}>
                          <SuggestionActions
                            lineId={line.id}
                            kind={i.kind}
                            itemId={i.id}
                            label={i.code}
                            candidate={best}
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {suggestions.pages > 1 && (
          <nav aria-label={t("pagination")} className="mt-4 flex items-center gap-3">
            {suggestions.page > 1 && (
              <Link
                href={`/products/lines?line=${line.id}&page=${suggestions.page - 1}`}
                className={`${ghostButtonCls} inline-flex items-center`}
              >
                ←
              </Link>
            )}
            <span className="text-muted">
              {t("pageOf", { page: suggestions.page, pages: suggestions.pages })}
            </span>
            {suggestions.page < suggestions.pages && (
              <Link
                href={`/products/lines?line=${line.id}&page=${suggestions.page + 1}`}
                className={`${ghostButtonCls} inline-flex items-center`}
              >
                →
              </Link>
            )}
          </nav>
        )}
      </Card>
    </>
  );
}
