"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { queueToWarehouseAction } from "@/app/actions/products";
import { buttonCls, tdCls, thCls } from "@/components/ui/form";

type Row = {
  id: string;
  sku: string;
  name: string;
  ean: string | null;
  missing: string[];
  request: { status: string; lastError: string | null } | null;
};

/** Pick masters on this page and queue their create at the warehouse. */
export function ToWarehousePicker({
  connectionId,
  rows,
  canWrite,
}: {
  connectionId: string;
  rows: Row[];
  canWrite: boolean;
}) {
  const t = useTranslations("toWarehouse");
  const router = useRouter();
  const ready = rows.filter((r) => !r.missing.length && !inFlight(r));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allPicked = ready.length > 0 && ready.every((r) => picked.has(r.id));
  const send = () =>
    start(async () => {
      const r = await queueToWarehouseAction({ connectionId, productIds: [...picked] });
      if ("error" in r)
        setMsg({ ok: false, text: t.has(`error.${r.error}`) ? t(`error.${r.error}`) : r.error });
      else {
        setMsg({
          ok: r.failed.length === 0,
          text: t("result", { queued: r.queued, already: r.already, failed: r.failed.length }),
        });
        setPicked(new Set());
        router.refresh();
      }
    });
  return (
    <div className="flex flex-col gap-3">
      {canWrite && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={buttonCls}
            disabled={pending || picked.size === 0}
            onClick={send}
            data-testid="to-warehouse-send"
          >
            {t("send", { n: picked.size })}
          </button>
          {msg && (
            <span role="status" className={`text-sm ${msg.ok ? "text-ok" : "text-warn"}`}>
              {msg.text}
            </span>
          )}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse" aria-label={t("table")}>
          <thead>
            <tr>
              {canWrite && (
                <th className={`${thCls} w-10`}>
                  <input
                    type="checkbox"
                    aria-label={t("pickAll")}
                    checked={allPicked}
                    disabled={!ready.length}
                    onChange={() => setPicked(allPicked ? new Set() : new Set(ready.map((r) => r.id)))}
                  />
                </th>
              )}
              <th className={thCls}>SKU</th>
              <th className={thCls}>{t("name")}</th>
              <th className={thCls}>EAN</th>
              <th className={thCls}>{t("state")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const busy = inFlight(r);
              return (
                <tr key={r.id} data-testid={`to-warehouse-row-${r.sku}`}>
                  {canWrite && (
                    <td className={tdCls}>
                      <input
                        type="checkbox"
                        aria-label={r.sku}
                        disabled={!!r.missing.length || busy}
                        checked={picked.has(r.id)}
                        onChange={() => toggle(r.id)}
                      />
                    </td>
                  )}
                  <td className={`${tdCls} font-mono text-[13px]`}>{r.sku}</td>
                  <td className={tdCls}>{r.name}</td>
                  <td className={`${tdCls} font-mono text-[13px]`}>{r.ean ?? "—"}</td>
                  <td className={`${tdCls} text-sm`}>
                    {r.missing.length ? (
                      <span className="text-warn">
                        {t("missing", { fields: r.missing.map((m) => t(`field.${m}`)).join(", ") })}
                      </span>
                    ) : r.request ? (
                      <span
                        className={
                          r.request.status === "FAILED" || r.request.status === "REFUSED"
                            ? "text-block"
                            : "text-muted"
                        }
                      >
                        {t.has(`status.${r.request.status}`)
                          ? t(`status.${r.request.status}`)
                          : r.request.status}
                        {r.request.lastError ? ` · ${r.request.lastError.slice(0, 120)}` : ""}
                      </span>
                    ) : (
                      <span className="text-ok">{t("ready")}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A create request that is on its way or done: not offered again. */
function inFlight(r: Row) {
  return !!r.request && !["FAILED", "REFUSED", "DRY_RUN_RECORDED"].includes(r.request.status);
}
