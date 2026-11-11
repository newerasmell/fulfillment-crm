"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { deleteNoCarrierRuleAction } from "@/app/actions/stores";
import { buttonCls, tdCls } from "@/components/ui/form";

/** One remembered courier for shipments without one (warehouse + country + company), with "Забрави". */
export function NoCarrierRuleRow({
  carrierKey,
  company,
  connectionName,
  countryCode,
  companyName,
  canEdit,
}: {
  carrierKey: string;
  company: string;
  connectionName: string | null;
  countryCode: string | null;
  companyName: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations("trackingLinks.noCarrier");
  const [gone, setGone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (gone) return null;
  const forget = () =>
    start(async () => {
      if (!window.confirm(t("confirm"))) return;
      const r = await deleteNoCarrierRuleAction(carrierKey);
      if ("error" in r) setErr(r.error === "forbidden" ? t("forbidden") : t("failed"));
      else setGone(true);
    });
  return (
    <tr data-testid="nocarrier-rule">
      <td className={tdCls}>{connectionName ?? t("unknown")}</td>
      <td className={tdCls}>{countryCode ?? "—"}</td>
      <td className={tdCls}>{companyName ?? "—"}</td>
      <td className={`${tdCls} font-semibold`}>{company}</td>
      <td className={`${tdCls} text-right`}>
        {canEdit && (
          <button
            type="button"
            className={`${buttonCls} px-3 py-1 text-sm`}
            disabled={pending}
            onClick={forget}
          >
            {t("forget")}
          </button>
        )}
        {err && <div className="text-xs text-block">{err}</div>}
      </td>
    </tr>
  );
}
