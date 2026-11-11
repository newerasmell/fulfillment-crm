import { getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { thCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { requireAccountContext } from "@/server/auth/session";
import { listCarrierTrackingLinks, listNoCarrierRules } from "@/server/shopify/tracking-links";
import { NoCarrierRuleRow } from "./no-carrier";
import { TrackingLinkRow } from "./row";

/**
 * "Линкове за проследяване" (owner request 2026-11-09): per courier the tracking link Shopify gets (and so the
 * customer clicks), as a template with {tracking}. Without one the warehouse's own link is sent.
 */
export default async function TrackingLinksPage() {
  const ctx = await requireAccountContext();
  const t = await getTranslations("trackingLinks");
  const [rows, rules] = await Promise.all([
    listCarrierTrackingLinks(ctx.accountId),
    listNoCarrierRules({ accountId: ctx.accountId, companyScope: ctx.companyScope }),
  ]);
  const canEdit = can(ctx.role, "stores.manage");
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("intro")} />
      <Card>
        {rows.length === 0 ? (
          <p className="m-0 text-sm text-muted">{t("none")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" aria-label={t("title")}>
              <thead>
                <tr>
                  <th className={thCls}>{t("carrier")}</th>
                  <th className={thCls}>{t("link")}</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <TrackingLinkRow key={r.carrierKey} {...r} canEdit={canEdit} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mb-0 mt-3 text-xs text-muted">{t("note")}</p>
      </Card>
      <Card>
        <h2 className="m-0 mb-1 text-base font-semibold">{t("noCarrier.title")}</h2>
        <p className="m-0 mb-3 text-sm text-muted">{t("noCarrier.intro")}</p>
        {rules.length === 0 ? (
          <p className="m-0 text-sm text-muted">{t("noCarrier.none")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" aria-label={t("noCarrier.title")}>
              <thead>
                <tr>
                  <th className={thCls}>{t("noCarrier.warehouse")}</th>
                  <th className={thCls}>{t("noCarrier.country")}</th>
                  <th className={thCls}>{t("noCarrier.company")}</th>
                  <th className={thCls}>{t("noCarrier.courier")}</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <NoCarrierRuleRow
                    key={r.carrierKey}
                    carrierKey={r.carrierKey}
                    company={r.company}
                    connectionName={r.connectionName}
                    countryCode={r.countryCode}
                    companyName={r.companyName}
                    canEdit={canEdit}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
