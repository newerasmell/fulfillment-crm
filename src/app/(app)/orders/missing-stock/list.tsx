"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { decideStockWaitAction } from "@/app/actions/review";
import { ConnectionChip } from "@/app/(app)/products/stock/ui";
import { buttonCls, tdCls, thCls } from "@/components/ui/form";
import type { StockWaitTab, WaitLineDetail } from "@/server/stock/waiting";

export interface StockWaitRow {
  orderId: string;
  number: string;
  placedAt: string;
  customerName: string | null;
  storeName: string | null;
  storeMode: string | null;
  canWriteTags: boolean | null;
  expected: boolean;
  readyConnectionId: string | null;
  lines: WaitLineDetail[];
  evaluated: boolean;
  lastWrite: { status: string; add: string[]; remove: string[]; lastError: string | null } | null;
}

const OPEN_WRITE = new Set(["PENDING", "SENDING", "PAUSED"]);

/** Rows of one tab with per-line status and the tab's action ("Чака зареждане" / "Потвърди"), one or many at once. */
export function StockWaitList({
  tab,
  rows,
  canDecide,
  connections,
}: {
  tab: StockWaitTab;
  rows: StockWaitRow[];
  canDecide: boolean;
  connections: { id: string; name: string; type: string }[];
}) {
  const t = useTranslations("missingStock");
  const format = useFormatter();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const conn = new Map(connections.map((c) => [c.id, c]));
  const action = tab === "out" ? "waiting" : tab === "ready" ? "confirm" : null;
  /** A row the action applies to: out_of_stock with every missing item expected, or READY; nothing on its way. */
  const actionable = (r: StockWaitRow) =>
    !!action &&
    r.canWriteTags !== false &&
    r.storeMode !== "READ_ONLY" &&
    !(r.lastWrite && OPEN_WRITE.has(r.lastWrite.status)) &&
    (action === "confirm" || r.expected);
  const ready = rows.filter(actionable);

  const run = (orderIds: string[]) => {
    if (!action || !orderIds.length) return;
    start(async () => {
      const r = await decideStockWaitAction({ action, orderIds });
      if ("error" in r)
        setMessage({ ok: false, text: t.has(`error.${r.error}`) ? t(`error.${r.error}`) : r.error });
      else {
        setMessage({ ok: true, text: t("queued", { n: r.queued, skipped: r.skipped }) });
        setPicked(new Set());
        router.refresh();
      }
    });
  };
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="flex flex-col gap-3">
      {canDecide && action && ready.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={buttonCls}
            disabled={pending || picked.size === 0}
            onClick={() => run([...picked])}
            data-testid="missing-stock-bulk"
          >
            {t(`action.${action}Picked`, { n: picked.size })}
          </button>
          <button
            type="button"
            className="text-sm text-accent-strong underline"
            onClick={() => setPicked(new Set(ready.map((r) => r.orderId)))}
          >
            {t("pickAll", { n: ready.length })}
          </button>
        </div>
      )}
      {message && (
        <p role="status" className={`m-0 text-sm ${message.ok ? "text-ok" : "text-block"}`}>
          {message.text}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse" aria-label={t(`tab.${tab}`)}>
          <thead>
            <tr>
              {canDecide && action && <th className={thCls} aria-label={t("pick")} />}
              <th className={thCls}>{t("col.order")}</th>
              <th className={thCls}>{t("col.items")}</th>
              <th className={thCls}>{t("col.shopify")}</th>
              {canDecide && action && <th className={thCls} />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const can = actionable(r);
              const ready = r.readyConnectionId ? conn.get(r.readyConnectionId) : null;
              return (
                <tr key={r.orderId} data-testid="missing-stock-row" data-order={r.number}>
                  {canDecide && action && (
                    <td className={`${tdCls} align-top`}>
                      <input
                        type="checkbox"
                        aria-label={t("pickOne", { n: r.number })}
                        disabled={!can}
                        checked={picked.has(r.orderId)}
                        onChange={() => toggle(r.orderId)}
                      />
                    </td>
                  )}
                  <td className={`${tdCls} align-top`}>
                    <Link
                      href={`/orders/${encodeURIComponent(r.orderId)}`}
                      className="font-mono font-semibold"
                    >
                      {r.number}
                    </Link>
                    <div className="text-xs text-muted">
                      {[r.storeName, r.customerName].filter(Boolean).join(" · ")}
                    </div>
                    <div className="text-xs text-muted">
                      {format.dateTime(new Date(r.placedAt), { dateStyle: "short", timeStyle: "short" })}
                    </div>
                    {ready && (
                      <div className="mt-1 flex items-center gap-1 text-xs">
                        {t("readyAt")} <ConnectionChip type={ready.type} name={ready.name} />
                      </div>
                    )}
                  </td>
                  <td className={`${tdCls} align-top`}>
                    {!r.evaluated ? (
                      <span className="text-sm text-muted">{t("notYet")}</span>
                    ) : (
                      <ul className="m-0 flex list-none flex-col gap-1 p-0">
                        {r.lines.map((l) => (
                          <li key={l.lineId} className="text-sm" data-testid="missing-stock-line">
                            <span className="font-medium">{l.title}</span>
                            {l.sku && <span className="ml-1 font-mono text-xs text-muted">{l.sku}</span>}
                            <span className="ml-1 text-muted">× {l.quantity}</span>{" "}
                            {l.unlinked ? (
                              <span className="text-warn">· {t("line.unlinked")}</span>
                            ) : l.available ? (
                              <span className="text-ok">
                                · {l.wasMissing ? t("line.back") : t("line.available")}
                              </span>
                            ) : (
                              <span className="text-block">· {t("line.missing")}</span>
                            )}
                            {!l.available &&
                              l.expected.map((e) => (
                                <div key={e.inboundId} className="ml-3 text-xs text-muted">
                                  {t("line.expected", {
                                    n: e.remaining,
                                    warehouse: conn.get(e.connectionId)?.name ?? "—",
                                  })}
                                  {e.expectedAt &&
                                    ` · ${t("line.expectedAt", {
                                      date: format.dateTime(new Date(e.expectedAt), { dateStyle: "short" }),
                                    })}`}
                                </div>
                              ))}
                            {!l.available && !l.unlinked && l.expected.length === 0 && (
                              <div className="ml-3 text-xs text-muted">{t("line.notExpected")}</div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className={`${tdCls} align-top text-sm`}>
                    {r.canWriteTags === false && <div className="text-block">{t("noScope")}</div>}
                    {r.storeMode === "READ_ONLY" && <div className="text-warn">{t("readOnly")}</div>}
                    {r.lastWrite && (
                      <div data-testid="missing-stock-write">
                        {t(`write.${r.lastWrite.status}`, {
                          tags: r.lastWrite.add.length
                            ? r.lastWrite.add.join(", ")
                            : t("withoutTags", { tags: r.lastWrite.remove.join(", ") }),
                        })}
                        {r.lastWrite.status === "FAILED" && r.lastWrite.lastError && (
                          <div className="text-xs text-block">{r.lastWrite.lastError}</div>
                        )}
                      </div>
                    )}
                  </td>
                  {canDecide && action && (
                    <td className={`${tdCls} align-top`}>
                      {can ? (
                        <button
                          type="button"
                          className={buttonCls}
                          disabled={pending}
                          onClick={() => run([r.orderId])}
                          data-testid="missing-stock-action"
                        >
                          {t(`action.${action}`)}
                        </button>
                      ) : action === "waiting" && !r.expected && r.evaluated ? (
                        <span className="text-xs text-muted">{t("notExpectedHint")}</span>
                      ) : null}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
