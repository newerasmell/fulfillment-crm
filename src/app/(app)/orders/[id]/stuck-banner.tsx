import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { orderCaseInfo } from "@/server/warehouse-cases/cases";

/** „Блокирани в склад“ on the order page: how long the shipment has waited, its level, the link to its case. */
export async function StuckCaseBanner({ accountId, orderId }: { accountId: string; orderId: string }) {
  const rows = await orderCaseInfo(accountId, orderId);
  if (!rows.length) return null;
  const t = await getTranslations("warehouseCases");
  const format = await getFormatter();
  return (
    <>
      {rows.map((r) => (
        <p
          key={r.caseId}
          role="status"
          data-testid="stuck-banner"
          className={`m-0 rounded-lg px-3 py-2 ${r.level >= 3 ? "bg-block-bg text-block" : "bg-warn-bg text-warn"}`}
        >
          <strong>{t("banner", { warehouse: r.connectionName, hours: r.hours })}</strong> ·{" "}
          {t(`level.${r.level}`)}
          {r.deleteUntil &&
            ` · ${t("deleteUntil", { date: format.dateTime(r.deleteUntil, { dateStyle: "short" }) })}`}
          {r.warehouseConfirmedAt && ` · ${t("confirmed")}`}
          {r.customerEmailedAt && ` · ${t("customerEmailed")}`}{" "}
          <Link className="font-semibold underline" href={`/orders/stuck#case-${r.caseId}`}>
            {t("bannerLink")}
          </Link>
        </p>
      ))}
    </>
  );
}
