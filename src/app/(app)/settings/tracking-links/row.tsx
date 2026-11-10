"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { saveTrackingLinkAction } from "@/app/actions/stores";
import { buttonCls, inputCls, tdCls } from "@/components/ui/form";

const PLACEHOLDER = "{tracking}";
const apply = (t: string, n: string) => t.split(PLACEHOLDER).join(encodeURIComponent(n));

/** One courier: its link template, a live preview with a recent number, save. */
export function TrackingLinkRow({
  carrierName,
  shipments,
  shopifyCompany,
  urlTemplate,
  sampleNumber,
  sampleWarehouseUrl,
  canEdit,
}: {
  carrierName: string;
  shipments: number;
  shopifyCompany: string | null;
  urlTemplate: string | null;
  sampleNumber: string | null;
  sampleWarehouseUrl: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations("trackingLinks");
  const [value, setValue] = useState(urlTemplate ?? "");
  const [saved, setSaved] = useState(urlTemplate ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const sample = sampleNumber ?? "TEST123";
  const preview = value.includes(PLACEHOLDER) ? apply(value, sample) : null;
  const save = () =>
    start(async () => {
      const r = await saveTrackingLinkAction({ carrierName, urlTemplate: value });
      if ("error" in r)
        setMsg({ ok: false, text: t.has(`error.${r.error}`) ? t(`error.${r.error}`) : r.error });
      else {
        setSaved(r.urlTemplate ?? "");
        setValue(r.urlTemplate ?? "");
        setMsg({ ok: true, text: r.urlTemplate ? t("saved") : t("cleared") });
      }
    });
  return (
    <tr data-testid={`tracking-link-${carrierName}`}>
      <td className={tdCls}>
        <div className="font-semibold">{carrierName}</div>
        <div className="text-xs text-muted">
          {t("shipments", { n: shipments })}
          {shopifyCompany ? ` · Shopify: ${shopifyCompany}` : ` · ${t("noCompany")}`}
        </div>
      </td>
      <td className={tdCls}>
        <div className="flex flex-col gap-1">
          <input
            className={`${inputCls} w-full min-w-[22rem] font-mono text-[13px]`}
            value={value}
            disabled={!canEdit}
            placeholder={`https://…/${PLACEHOLDER}`}
            aria-label={t("template", { carrier: carrierName })}
            onChange={(e) => setValue(e.target.value)}
          />
          {preview ? (
            <a
              href={preview}
              target="_blank"
              rel="noreferrer noopener"
              className="break-all text-xs text-accent"
            >
              {t("test", { number: sample })}: {preview}
            </a>
          ) : value ? (
            <span className="text-xs text-warn">{t("needPlaceholder")}</span>
          ) : (
            <span className="break-all text-xs text-muted">
              {sampleWarehouseUrl ? t("nowWarehouse", { url: sampleWarehouseUrl }) : t("nowNone")}
            </span>
          )}
          {msg && <span className={`text-xs ${msg.ok ? "text-ok" : "text-block"}`}>{msg.text}</span>}
        </div>
      </td>
      <td className={`${tdCls} text-right`}>
        {canEdit && (
          <button
            type="button"
            className={`${buttonCls} px-3 py-1 text-sm`}
            disabled={pending || value.trim() === saved}
            onClick={save}
          >
            {t("save")}
          </button>
        )}
      </td>
    </tr>
  );
}
