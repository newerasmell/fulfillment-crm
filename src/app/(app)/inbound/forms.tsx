"use client";

import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import {
  createInboundAction,
  parseInboundUploadAction,
  searchInboundProductsAction,
  type UploadResult,
} from "@/app/actions/stock";
import { StockError } from "@/app/(app)/products/stock/forms";
import { buttonCls, ghostButtonCls, inputCls, labelCls, tdCls, thCls } from "@/components/ui/form";

export interface InboundConnectionOption {
  id: string;
  name: string;
  type: string;
  liveMode: string;
  warehouses: { warehouseId: number; name: string }[];
  carriers: { code: string; name: string | null }[];
}

interface Line {
  productId: string;
  sku: string;
  name: string;
  vendorId: string | null;
  quantity: number;
}

/**
 * New inbound (P5-02): warehouse → product picker and/or XLSX/CSV upload (SKU, qty) → lines → create. The request
 * token is generated when the page renders and travels with the form, so a double click or a resubmitted form is
 * the same receipt / booking (the server derives the vendor id from it).
 */
export function NewInboundForm({
  connections,
  requestToken,
  initial,
}: {
  connections: InboundConnectionOption[];
  requestToken: string;
  initial?: { connectionId: string; line: Line } | null;
}) {
  const t = useTranslations("stock.inbound");
  const [connectionId, setConnectionId] = useState(initial?.connectionId ?? connections[0]?.id ?? "");
  const connection = connections.find((c) => c.id === connectionId);
  const [lines, setLines] = useState<Line[]>(initial ? [initial.line] : []);
  const [state, action, pending] = useActionState(createInboundAction, undefined);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    { id: string; sku: string; name: string; vendorId: string | null }[]
  >([]);
  const [, startSearch] = useTransition();
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [uploading, startUpload] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (query.trim().length < 2 || !connectionId) return;
    const id = setTimeout(
      () =>
        startSearch(async () => {
          setResults(await searchInboundProductsAction(connectionId, query));
        }),
      250,
    );
    return () => clearTimeout(id);
  }, [query, connectionId]);

  const add = (l: Line) =>
    setLines((prev) => {
      const i = prev.findIndex((x) => x.productId === l.productId);
      if (i < 0) return [...prev, l];
      const next = [...prev];
      next[i] = { ...next[i]!, quantity: next[i]!.quantity + l.quantity };
      return next;
    });

  const onUpload = () => {
    const f = fileRef.current?.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.set("file", f);
    startUpload(async () => {
      const r = await parseInboundUploadAction(connectionId, fd);
      setUpload(r);
      if (r.ok)
        for (const l of r.lines)
          if (l.productId && !l.problem)
            add({
              productId: l.productId,
              sku: l.sku!,
              name: l.name!,
              vendorId: l.vendorId,
              quantity: l.quantity,
            });
    });
  };

  const total = useMemo(() => lines.reduce((s, l) => s + l.quantity, 0), [lines]);
  const eu = connection?.type === "EUSHIPMENTS";

  return (
    <form action={action} className="flex flex-col gap-4" aria-label={t("formLabel")}>
      <input type="hidden" name="requestToken" value={requestToken} />
      <input
        type="hidden"
        name="lines"
        value={JSON.stringify(lines.map((l) => ({ productId: l.productId, quantity: l.quantity })))}
      />
      <div className="grid gap-3 md:grid-cols-3">
        <label className={labelCls}>
          {t("warehouse")}
          <select
            name="connectionId"
            value={connectionId}
            onChange={(e) => {
              setConnectionId(e.target.value);
              setLines([]);
              setUpload(null);
            }}
            className={inputCls}
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.type === "EUSHIPMENTS" ? "euShipments" : "FHB"} · {c.liveMode}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          {t("name")}
          <input
            name="name"
            required
            maxLength={50}
            className={inputCls}
            placeholder={t("namePlaceholder")}
          />
        </label>
        <label className={labelCls}>
          {t("expectedDate")}
          <input name="expectedDate" type="date" className={inputCls} />
        </label>
        {eu ? (
          <>
            <label className={labelCls}>
              {t("euWarehouse")}
              <select name="warehouseId" required className={inputCls} defaultValue="">
                <option value="" disabled>
                  {t("choose")}
                </option>
                {connection.warehouses.map((w) => (
                  <option key={w.warehouseId} value={w.warehouseId}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              {t("courier")}
              <input name="courierInc" maxLength={50} className={inputCls} />
            </label>
            <label className={labelCls}>
              {t("packages")}
              <input name="packagesCount" type="number" min={1} max={10000} className={inputCls} />
            </label>
          </>
        ) : (
          <label className={labelCls}>
            {t("deliveryService")}
            <select name="deliveryService" className={inputCls} defaultValue="">
              <option value="">—</option>
              {connection?.carriers.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name ?? c.code}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={labelCls}>
          {t("tracking")}
          <input name="trackingCode" maxLength={50} className={inputCls} />
        </label>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-2 rounded-[10px] border border-line p-3">
          <h2 className="m-0 text-sm font-semibold">{t("pickerTitle")}</h2>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("pickerPlaceholder")}
            aria-label={t("pickerTitle")}
            className={inputCls}
          />
          <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label={t("results")}>
            {(query.trim().length >= 2 ? results : []).map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  <span className="font-mono">{r.sku}</span> · {r.name}
                  {r.vendorId && <span className="ml-1 font-mono text-xs text-muted">{r.vendorId}</span>}
                </span>
                <button
                  type="button"
                  className={ghostButtonCls}
                  onClick={() =>
                    add({ productId: r.id, sku: r.sku, name: r.name, vendorId: r.vendorId, quantity: 1 })
                  }
                >
                  {t("add")}
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="flex flex-col gap-2 rounded-[10px] border border-line p-3">
          <h2 className="m-0 text-sm font-semibold">{t("uploadTitle")}</h2>
          <p className="m-0 text-xs text-muted">{t("uploadHint")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              aria-label={t("uploadFile")}
              className={`${inputCls} py-2`}
            />
            <button type="button" onClick={onUpload} disabled={uploading} className={ghostButtonCls}>
              {t("uploadButton")}
            </button>
          </div>
          {upload && !upload.ok && <StockError code={upload.error} />}
          {upload?.ok && (
            <div className="text-sm" role="status">
              {t("uploadResult", {
                ok: upload.lines.filter((l) => !l.problem).length,
                bad: upload.lines.filter((l) => l.problem).length + upload.errors.length,
              })}
              <ul className="m-0 mt-1 list-none p-0 text-xs text-block">
                {upload.lines
                  .filter((l) => l.problem)
                  .map((l) => (
                    <li key={l.row}>
                      {t("row", { row: l.row })}: <span className="font-mono">{l.code}</span> —{" "}
                      {t(`problem.${l.problem}`)}
                    </li>
                  ))}
                {upload.errors.map((e) => (
                  <li key={`${e.row}-${e.code}`}>
                    {e.row ? `${t("row", { row: e.row })}: ` : ""}
                    {t(`problem.${e.code}`)}
                    {e.value ? ` (${e.value})` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>

      <section>
        <h2 className="m-0 mb-2 text-sm font-semibold">
          {t("lines")}{" "}
          <span className="font-mono text-muted">
            {lines.length} · {total}
          </span>
        </h2>
        {lines.length === 0 ? (
          <p className="m-0 text-sm text-muted">{t("noLines")}</p>
        ) : (
          <table className="w-full border-collapse" aria-label={t("lines")}>
            <thead>
              <tr>
                <th className={thCls}>SKU</th>
                <th className={thCls}>{t("product")}</th>
                <th className={thCls}>{t("warehouseCode")}</th>
                <th className={`${thCls} text-right`}>{t("qty")}</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.productId}>
                  <td className={`${tdCls} font-mono text-[13px]`}>{l.sku}</td>
                  <td className={tdCls}>{l.name}</td>
                  <td className={`${tdCls} font-mono text-[13px] text-muted`}>{l.vendorId ?? "—"}</td>
                  <td className={`${tdCls} text-right`}>
                    <input
                      type="number"
                      min={1}
                      max={1000000}
                      value={l.quantity}
                      aria-label={t("qtyFor", { sku: l.sku })}
                      onChange={(e) => {
                        const q = Math.max(1, Math.trunc(Number(e.target.value) || 1));
                        setLines((prev) => prev.map((x, j) => (j === i ? { ...x, quantity: q } : x)));
                      }}
                      className={`${inputCls} w-28 text-right`}
                    />
                  </td>
                  <td className={tdCls}>
                    <button
                      type="button"
                      className="text-sm text-block hover:underline"
                      onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}
                    >
                      {t("remove")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending || lines.length === 0} className={buttonCls}>
          {eu ? t("submitEu") : t("submitFhb")}
        </button>
        <span className="text-xs text-muted">{t("modeNote", { mode: connection?.liveMode ?? "—" })}</span>
      </div>
      <StockError code={state?.error} detail={state?.detail} />
    </form>
  );
}
