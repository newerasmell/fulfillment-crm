"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { searchOfficesAction, setDeliveryOfficeAction } from "@/app/actions/delivery-office";
import { ghostButtonCls, inputCls } from "@/components/ui/form";

type Resolution =
  | { kind: "address" }
  | { kind: "office"; officeId: number; name: string; source: "chosen" | "speedy_id" | "name" }
  | { kind: "unresolved"; reason: string; search: string };

interface Office {
  officeId: number;
  courierOfficeId: number | null;
  name: string;
  cityName: string | null;
  address: string | null;
  isStation: boolean;
}

/** "Доставка": До адрес / До офис for orders to Bulgaria (Speedy office recognised from the address or picked). */
export function DeliveryOffice({
  orderId,
  version,
  resolution,
  courierName,
  manual,
  editable,
}: {
  orderId: string;
  version: string;
  resolution: Resolution;
  /** The order's courier at this warehouse (offices are searched in its list). */
  courierName: string | null;
  manual: boolean;
  editable: boolean;
}) {
  const t = useTranslations("orders.deliveryOffice");
  const router = useRouter();
  const toOffice = resolution.kind !== "address";
  const [mode, setMode] = useState<"address" | "office">(toOffice ? "office" : "address");
  const [q, setQ] = useState(resolution.kind === "unresolved" ? resolution.search : "");
  const [results, setResults] = useState<Office[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (mode !== "office" || q.trim().length < 2) return;
    let live = true;
    const h = setTimeout(async () => {
      const r = await searchOfficesAction(orderId, q);
      if (live) setResults(r);
    }, 250);
    return () => {
      live = false;
      clearTimeout(h);
    };
  }, [q, mode, orderId]);
  const shown = mode === "office" && q.trim().length >= 2 ? results : [];

  const save = (choice: Parameters<typeof setDeliveryOfficeAction>[0]["choice"]) =>
    start(async () => {
      const r = await setDeliveryOfficeAction({ orderId, version, choice });
      if ("error" in r) setErr(t.has(`error.${r.error}`) ? t(`error.${r.error}`) : t("error.other"));
      else {
        setErr(null);
        router.refresh();
      }
    });

  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="delivery-office">
      <div className="inline-flex w-fit overflow-hidden rounded-md border border-line" role="group">
        {(["address", "office"] as const).map((m) => (
          <button
            key={m}
            type="button"
            disabled={!editable || pending}
            aria-pressed={mode === m}
            className={`px-3 py-1 text-sm ${mode === m ? "bg-accent text-white" : "bg-surface text-ink"}`}
            onClick={() => {
              setMode(m);
              if (m === "address" && toOffice) save({ mode: "address" });
            }}
          >
            {t(`mode.${m}`)}
          </button>
        ))}
      </div>

      {mode === "office" && resolution.kind === "office" && (
        <div data-testid="delivery-office-selected">
          <div className="font-semibold">{resolution.name}</div>
          <div className="text-xs text-muted">
            {t(`source.${resolution.source}`)} · ID {resolution.officeId}
          </div>
        </div>
      )}
      {mode === "office" && resolution.kind === "unresolved" && (
        <p
          className="m-0 rounded-md bg-warn-bg px-2 py-1 text-xs text-warn"
          data-testid="delivery-office-unresolved"
        >
          {t(`unresolved.${resolution.reason}`, { name: resolution.search })}
        </p>
      )}

      {mode === "office" && editable && (
        <div className="flex flex-col gap-1">
          <input
            className={inputCls}
            value={q}
            placeholder={t("search")}
            aria-label={t("search")}
            onChange={(e) => setQ(e.target.value)}
          />
          {shown.length > 0 && (
            <ul className="m-0 flex max-h-64 list-none flex-col overflow-auto rounded-md border border-line p-0">
              {shown.map((o) => (
                <li key={o.officeId}>
                  <button
                    type="button"
                    className="w-full px-2 py-1 text-left hover:bg-hover"
                    disabled={pending}
                    onClick={() => save({ mode: "office", officeId: o.officeId, name: o.name })}
                  >
                    <span className="font-semibold">{o.name}</span>
                    <span className="block text-xs text-muted">
                      {[o.cityName, o.address].filter(Boolean).join(", ")}
                      {o.courierOfficeId ? ` · Speedy ${o.courierOfficeId}` : ""}
                      {o.isStation ? ` · ${t("locker")}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {editable && manual && (
        <button
          type="button"
          className={`${ghostButtonCls} w-fit px-2 py-1 text-xs`}
          disabled={pending}
          onClick={() => save(null)}
        >
          {t("auto")}
        </button>
      )}
      {courierName && <span className="text-xs text-muted">{t("courier", { name: courierName })}</span>}
      {!editable && <span className="text-xs text-muted">{t("locked")}</span>}
      {err && <span className="text-xs text-block">{err}</span>}
      {pending && <span className="text-xs text-muted">{t("saving")}</span>}
    </div>
  );
}
