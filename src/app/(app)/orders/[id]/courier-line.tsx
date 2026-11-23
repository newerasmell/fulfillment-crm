import { getFormatter, getTranslations } from "next-intl/server";
import { latestCourierStatus } from "@/server/fhb/courier";

/** „Последно от куриера“ on the order page (owner request 2026-11-23): no need to open the carrier's tracking. */
export async function CourierLine({ accountId, orderId }: { accountId: string; orderId: string }) {
  const rows = await latestCourierStatus(accountId, orderId);
  if (!rows.length) return null;
  const t = await getTranslations("orders.courier");
  const format = await getFormatter();
  return (
    <>
      {rows.map((r) => (
        <p
          key={r.fulfillmentId}
          data-testid="courier-line"
          className={`m-0 rounded-lg px-3 py-2 text-sm ${r.returning ? "bg-block-bg text-block" : "bg-hover text-ink-2"}`}
        >
          <strong>{t("label")}</strong> {r.carrier ? `${r.carrier}: ` : ""}
          {r.message} · {format.dateTime(r.at, { dateStyle: "short", timeStyle: "short" })}
          {r.tracking && <span className="text-muted"> · {r.tracking}</span>}
          {r.returning && <strong> · {t("returning")}</strong>}
        </p>
      ))}
    </>
  );
}
