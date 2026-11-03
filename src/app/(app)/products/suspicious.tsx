import { getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/PageHeader";
import { tdCls, thCls } from "@/components/ui/form";
import type { SuspiciousRow } from "@/server/products/suspicious";
import { SuspiciousActions } from "./suspicious-actions";

/**
 * "Съмнителни връзки (N)": links whose two names disagree (SKU reused for another product, other volume).
 * Until confirmed, such a store variant is not pushed to Shopify and its orders get a soft finding.
 */
export async function SuspiciousLinksCard({
  rows,
  total,
  canDecide,
}: {
  rows: SuspiciousRow[];
  total: number;
  canDecide: boolean;
}) {
  const t = await getTranslations("suspicious");
  return (
    <Card>
      <section id="suspicious-links" aria-label={t("title", { count: total })} data-testid="suspicious-links">
        <h2 className="mt-0 text-base font-semibold">
          {t("title", { count: total })}
          {total > 0 && (
            <span className="ml-2 rounded-full bg-warn-bg px-2 py-0.5 align-middle text-xs font-semibold text-warn">
              {t("badge")}
            </span>
          )}
        </h2>
        <p className="mt-0 text-[13px] text-muted">{t("intro")}</p>
        {rows.length === 0 ? (
          <p className="m-0 text-muted">{t("empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>{t("masterSku")}</th>
                  <th className={thCls}>{t("masterName")}</th>
                  <th className={thCls}>{t("itemName")}</th>
                  <th className={`${thCls} text-right`}>{t("score")}</th>
                  {canDecide && <th className={thCls} />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-testid={`suspicious-${r.itemCode ?? r.itemId}`}>
                    <td className={`${tdCls} font-mono text-[13px]`}>{r.productSku}</td>
                    <td className={tdCls}>{r.productName}</td>
                    <td className={tdCls}>
                      <span className="block">{r.itemName}</span>
                      <span className="block text-[12px] text-muted">
                        <span
                          aria-hidden
                          className={`mr-1.5 inline-block size-2 rounded-full ${r.sourceType === "FHB_V3" ? "bg-fhb" : r.sourceType === "EUSHIPMENTS" ? "bg-eu" : "bg-muted"}`}
                        />
                        {r.kind === "variant" ? t("store") : t("warehouse")}: {r.source}
                        {r.itemCode ? <span className="font-mono"> · {r.itemCode}</span> : null}
                      </span>
                    </td>
                    <td className={`${tdCls} text-right`}>
                      <span className="block font-mono font-semibold text-warn">
                        {r.score === null ? "—" : `${Math.round(r.score * 100)}%`}
                      </span>
                      <span className="block text-[12px] text-muted">
                        {r.reasons.map((x) => t(`reason.${x}`)).join(" · ")}
                      </span>
                    </td>
                    {canDecide && (
                      <td className={tdCls}>
                        <SuspiciousActions id={r.id} label={`${r.productSku} · ${r.itemName}`} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {total > rows.length && (
              <p className="mb-0 mt-2 text-[13px] text-muted">{t("more", { shown: rows.length, total })}</p>
            )}
          </div>
        )}
      </section>
    </Card>
  );
}
