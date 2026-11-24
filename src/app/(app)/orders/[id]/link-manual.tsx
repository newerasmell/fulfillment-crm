"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { findShopifyOrdersToLinkAction, linkManualToShopifyOrderAction } from "@/app/actions/labels";
import { ghostButtonCls, inputCls } from "@/components/ui/form";

type Found = Awaited<ReturnType<typeof findShopifyOrdersToLinkAction>>[number];

/**
 * „Прикачи към поръчка от Shopify“ on a manual order (owner request 2026-11-24, optional): search the Shopify order by
 * its number and attach this manual shipment to it.
 */
export function LinkManual({
  manualOrderId,
  suggested,
}: {
  manualOrderId: string;
  suggested: string | null;
}) {
  const t = useTranslations("orders.linkManual");
  const tStatus = useTranslations("orderStatus");
  const [searched, setSearched] = useState(false);
  const router = useRouter();
  const [q, setQ] = useState(suggested ?? "");
  const [found, setFound] = useState<Found[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; number: string } | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    if (q.trim().length < 2) return;
    const id = setTimeout(
      () =>
        start(async () => {
          setFound(await findShopifyOrdersToLinkAction(manualOrderId, q));
          setSearched(true);
        }),
      250,
    );
    return () => clearTimeout(id);
  }, [q, manualOrderId]);
  if (done)
    return (
      <p className="m-0 rounded-lg bg-ok-bg px-3 py-2 text-sm text-ok" role="status">
        {t("done")}{" "}
        <Link href={`/orders/${done.id}`} className="font-semibold underline">
          {done.number}
        </Link>
      </p>
    );
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-line p-3 text-sm"
      aria-label={t("title")}
      data-testid="link-manual"
    >
      <strong>{t("title")}</strong>
      <span className="text-xs text-muted">{t("hint")}</span>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label={t("search")}
        placeholder={t("placeholder")}
        className={`${inputCls} font-mono`}
      />
      {q.trim().length >= 2 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label={t("results")}>
          {searched && found.length === 0 && <li className="text-muted">{t("none")}</li>}
          {found.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <span className="font-mono font-semibold">{o.number}</span> · {o.customerName ?? "—"} ·{" "}
                <span className="text-muted">{tStatus(o.status)}</span>
              </span>
              <button
                type="button"
                className={ghostButtonCls}
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    if (!window.confirm(t("confirm", { number: o.number }))) return;
                    setError(null);
                    let r = await linkManualToShopifyOrderAction(manualOrderId, o.id);
                    // Different cash on delivery: attached only when the person confirms it (a task follows).
                    if ("error" in r && r.error === "cod_differs" && r.cod) {
                      if (!window.confirm(t("codDiffers", r.cod))) return;
                      r = await linkManualToShopifyOrderAction(manualOrderId, o.id, true);
                    }
                    if ("error" in r) {
                      setError(t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : t("errors.other"));
                      return;
                    }
                    setDone({ id: r.orderId, number: r.orderNumber });
                    router.refresh();
                  })
                }
              >
                {t("link")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="m-0 text-block" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
