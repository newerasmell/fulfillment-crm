import { getTranslations } from "next-intl/server";
import { COVERAGE_TARGET, ratioOf, type LineCoverage } from "@/server/lines/coverage";

const pct = (linked: number, total: number) => `${Math.floor(ratioOf(linked, total) * 1000) / 10}%`;

/** Coverage of one line: warehouse products and store variants linked to a master (target ≥ 99% before LIVE). */
export async function CoverageSummary({
  coverage,
  detailed = false,
}: {
  coverage: LineCoverage;
  detailed?: boolean;
}) {
  const t = await getTranslations("lines");
  const ok = coverage.meetsTarget;
  return (
    <div data-testid={`coverage-${coverage.lineId}`} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-lg font-semibold">
          {pct(
            coverage.warehouses.linked + coverage.stores.linked,
            coverage.warehouses.total + coverage.stores.total,
          )}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${ok ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn"}`}
        >
          {ok
            ? t("coverageOk", { target: COVERAGE_TARGET * 100 })
            : t("coverageLow", { target: COVERAGE_TARGET * 100 })}
        </span>
        <span className="text-[13px] text-muted">
          {t("coverageWarehouses", {
            linked: coverage.warehouses.linked,
            total: coverage.warehouses.total,
            pct: pct(coverage.warehouses.linked, coverage.warehouses.total),
          })}
          {" · "}
          {t("coverageStores", {
            linked: coverage.stores.linked,
            total: coverage.stores.total,
            pct: pct(coverage.stores.linked, coverage.stores.total),
          })}
        </span>
      </div>
      {detailed && coverage.parts.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
          {coverage.parts.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2">
              <span
                aria-hidden
                className={`size-2 rounded-full ${p.type === "FHB_V3" ? "bg-fhb" : p.type === "EUSHIPMENTS" ? "bg-eu" : "bg-muted"}`}
              />
              <span>{p.kind === "warehouse" ? t("warehouse") : t("store")}:</span>
              <span className="font-medium">{p.name}</span>
              <span className="font-mono text-muted">
                {p.linked}/{p.total} · {pct(p.linked, p.total)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
