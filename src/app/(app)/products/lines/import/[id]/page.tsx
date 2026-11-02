import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, tdCls, thCls } from "@/components/ui/form";
import { DomainError } from "@/server/accounts";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { getImport } from "@/server/lines/mapping";
import { ApplyImportForm } from "../../forms";

const SHOWN = 300;

/** Preview of an uploaded mapping file: errors (nothing can be applied) or every change it would make. */
export default async function ImportPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAccountContext("lines.catalogue");
  const t = await getTranslations("lines");
  const imp = await getImport(actorFrom(ctx), id).catch((err) => {
    if (err instanceof DomainError) notFound();
    throw err;
  });
  const { plan, errors } = imp;
  const moves = plan.links.filter((l) => l.fromProductId);
  const links = plan.links.filter((l) => !l.fromProductId);
  return (
    <>
      <PageHeader
        title={t("importPreviewTitle")}
        subtitle={t("importPreviewIntro", { file: imp.fileName })}
        actions={
          <Link
            href={`/products/lines?line=${imp.lineId}`}
            className={`${ghostButtonCls} inline-flex items-center`}
          >
            {t("backToLine")}
          </Link>
        }
      />
      <Card>
        <p data-testid="import-status" className="mt-0 font-semibold">
          {t(`importStatuses.${imp.status}`)}
        </p>
        {imp.status !== "INVALID" && (
          <ul
            data-testid="import-summary"
            className="mt-0 mb-4 flex list-none flex-wrap gap-4 p-0 text-[13px]"
          >
            <li>{t("planCreates", { count: plan.creates.length })}</li>
            <li>{t("planAdopts", { count: plan.adopts.length })}</li>
            <li>{t("planLinks", { count: links.length })}</li>
            <li>{t("planMoves", { count: moves.length })}</li>
            <li className="text-muted">{t("planUnchanged", { count: plan.unchanged })}</li>
          </ul>
        )}
        {imp.status === "PREVIEW" && (
          <ApplyImportForm
            importId={imp.id}
            disabled={plan.links.length + plan.creates.length + plan.adopts.length === 0}
          />
        )}
      </Card>
      {errors.length > 0 && (
        <Card>
          <h2 className="mt-0 text-base font-semibold text-block">
            {t("importErrors", { count: errors.length })}
          </h2>
          <div className="overflow-x-auto">
            <table
              className="w-full border-collapse"
              aria-label={t("importErrors", { count: errors.length })}
            >
              <thead>
                <tr>
                  <th className={thCls}>{t("row")}</th>
                  <th className={thCls}>{t("column")}</th>
                  <th className={thCls}>{t("problem")}</th>
                  <th className={thCls}>{t("value")}</th>
                </tr>
              </thead>
              <tbody>
                {errors.slice(0, SHOWN).map((e, i) => (
                  <tr key={i}>
                    <td className={`${tdCls} font-mono`}>{e.row}</td>
                    <td className={tdCls}>{e.column ?? "—"}</td>
                    <td className={tdCls}>{t(`importCodes.${e.code}`)}</td>
                    <td className={`${tdCls} font-mono`}>{e.value ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {(plan.creates.length > 0 || plan.links.length > 0) && errors.length === 0 && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("importChanges")}</h2>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" aria-label={t("importChanges")}>
              <thead>
                <tr>
                  <th className={thCls}>{t("change")}</th>
                  <th className={thCls}>{t("column")}</th>
                  <th className={thCls}>{t("item")}</th>
                  <th className={thCls}>{t("masterSku")}</th>
                </tr>
              </thead>
              <tbody>
                {plan.creates.slice(0, SHOWN).map((c) => (
                  <tr key={`c:${c.sku}`}>
                    <td className={tdCls}>{t("changeCreate")}</td>
                    <td className={tdCls}>—</td>
                    <td className={tdCls}>{c.name}</td>
                    <td className={`${tdCls} font-mono`}>{c.sku}</td>
                  </tr>
                ))}
                {plan.links.slice(0, SHOWN).map((l) => (
                  <tr key={`l:${l.kind}:${l.itemId}`}>
                    <td className={tdCls}>
                      {l.fromProductId ? t("changeMove", { from: l.fromSku ?? "?" }) : t("changeLink")}
                    </td>
                    <td className={tdCls}>{l.column}</td>
                    <td className={`${tdCls} font-mono`}>{l.token}</td>
                    <td className={`${tdCls} font-mono`}>{l.toSku}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.links.length + plan.creates.length > SHOWN && (
            <p className="mb-0 text-[13px] text-muted">{t("moreChanges", { shown: SHOWN })}</p>
          )}
        </Card>
      )}
    </>
  );
}
