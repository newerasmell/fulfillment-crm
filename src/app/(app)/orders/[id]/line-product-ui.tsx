"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import {
  chooseLineProductAction,
  clearLineProductAction,
  searchLineProductsAction,
} from "@/app/actions/review";
import { buttonCls, ghostButtonCls, inputCls } from "@/components/ui/form";

/** "Избери продукт за реда" (owner request 2026-11-05): pick the real product of one order line, this order only. */

type Result = {
  connections: { id: string; name: string; type: string }[];
  products: {
    id: string;
    sku: string;
    name: string;
    isTester: boolean;
    stock: Record<string, number | null>;
  }[];
};

export function LineProductPicker({
  orderId,
  lineId,
  title,
  chosen,
  qty,
}: {
  orderId: string;
  lineId: string;
  title: string;
  /** The line has a hand-picked product (shows "Смени" and "Махни избора"). */
  chosen: boolean;
  qty: number;
}) {
  const t = useTranslations("review.lineProduct");
  const te = useTranslations("review");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [note, setNote] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();
  const [saving, startSave] = useTransition();
  const seq = useRef(0);

  useEffect(() => {
    if (!open || q.trim().length < 2) return;
    const n = ++seq.current;
    const h = setTimeout(() => {
      startSearch(async () => {
        const r = await searchLineProductsAction(orderId, q);
        if (n !== seq.current) return;
        if ("error" in r) {
          setError(r.error);
          setRes(null);
        } else {
          setError(null);
          setRes(r);
        }
      });
    }, 250);
    return () => clearTimeout(h);
  }, [q, open, orderId]);

  const errText = (code: string) =>
    t.has(`error.${code}`) ? t(`error.${code}`) : te.has(`error.${code}`) ? te(`error.${code}`) : code;

  const choose = (productId: string) =>
    startSave(async () => {
      const r = await chooseLineProductAction({ orderId, lineId, productId, note: note || null });
      if (r?.error) setError(r.error);
      else {
        setOpen(false);
        setQ("");
        setRes(null);
        router.refresh();
      }
    });
  const clear = () =>
    startSave(async () => {
      const r = await clearLineProductAction({ orderId, lineId });
      if (r?.error) setError(r.error);
      else router.refresh();
    });

  if (!open)
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${ghostButtonCls} px-2 py-0.5 text-xs`}
          onClick={() => setOpen(true)}
          data-testid={`line-product-open-${lineId}`}
        >
          {chosen ? t("change") : t("choose")}
        </button>
        {chosen && (
          <button
            type="button"
            disabled={saving}
            className="text-xs text-muted underline"
            onClick={clear}
            data-testid={`line-product-clear-${lineId}`}
          >
            {t("clear")}
          </button>
        )}
        {error && <span className="text-xs text-block">{errText(error)}</span>}
      </span>
    );

  return (
    <div
      className="mt-2 w-[min(42rem,80vw)] rounded-md border border-line bg-surface p-3 text-left"
      data-testid={`line-product-picker-${lineId}`}
    >
      <div className="mb-2 text-sm font-semibold">{t("title", { title })}</div>
      <p className="mt-0 mb-2 text-xs text-muted">{t("hint")}</p>
      <div className="flex flex-wrap gap-2">
        <input
          autoFocus
          className={`${inputCls} min-w-56 flex-1`}
          placeholder={t("search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={t("search")}
        />
        <input
          className={`${inputCls} min-w-40 flex-1`}
          placeholder={t("note")}
          value={note}
          maxLength={300}
          onChange={(e) => setNote(e.target.value)}
          aria-label={t("note")}
        />
        <button type="button" className={ghostButtonCls} onClick={() => setOpen(false)}>
          {t("cancel")}
        </button>
      </div>
      {error && <p className="mb-0 text-sm text-block">{errText(error)}</p>}
      {searching && <p className="mb-0 text-xs text-muted">{t("searching")}</p>}
      {res && res.products.length === 0 && <p className="mb-0 text-sm text-muted">{t("none")}</p>}
      {res && res.products.length > 0 && (
        <div className="mt-2 max-h-80 overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-label">
                <th className="py-1 pr-2">SKU</th>
                <th className="py-1 pr-2">{t("name")}</th>
                {res.connections.map((c) => (
                  <th key={c.id} className="py-1 pr-2 text-right">
                    {c.name}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {res.products.map((p) => (
                <tr key={p.id} className="border-t border-line">
                  <td className="py-1 pr-2 font-mono text-[13px]">{p.sku}</td>
                  <td className="py-1 pr-2">{p.name}</td>
                  {res.connections.map((c) => {
                    const s = p.stock[c.id];
                    return (
                      <td
                        key={c.id}
                        className={`py-1 pr-2 text-right font-mono ${
                          s === undefined || s === null ? "text-muted" : s >= qty ? "text-ok" : "text-warn"
                        }`}
                      >
                        {s === undefined ? "—" : (s ?? "?")}
                      </td>
                    );
                  })}
                  <td className="py-1 text-right">
                    <button
                      type="button"
                      disabled={saving}
                      className={`${buttonCls} px-2 py-0.5 text-xs`}
                      onClick={() => choose(p.id)}
                      data-testid={`line-product-pick-${p.sku}`}
                    >
                      {t("pick")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
