"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  applyProductImportAction,
  previewProductImportAction,
  type ImportPreview,
  type ImportResult,
} from "@/app/actions/product-import";
import { buttonCls, ghostButtonCls, tdCls, thCls } from "@/components/ui/form";

type Column = { header: string; required: boolean; field: string };

/**
 * „Импорт от Excel“ (owner request 2026-11-23): products from a file into this warehouse, with exactly the columns the
 * warehouse requires. The file is checked row by row first; nothing is written before „Създай“.
 */
export function ProductImport({
  connectionId,
  type,
  columns,
}: {
  connectionId: string;
  type: "FHB_V3" | "EUSHIPMENTS";
  columns: Column[];
}) {
  const t = useTranslations("toWarehouse.import");
  const router = useRouter();
  const file = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const rows = preview?.ok ? preview.rows : [];
  const ready = rows.filter((r) => r.action === "create" || r.action === "update");
  const err = (code: string) => (t.has(`error.${code}`) ? t(`error.${code}`) : code);
  return (
    <details className="mb-4 rounded-lg border border-line p-3" data-testid="product-import">
      <summary className="cursor-pointer font-semibold">{t("title")}</summary>
      <p className="mb-2 mt-2 text-sm text-muted">{t("intro")}</p>
      <table className="mb-3 w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className={thCls}>{t("column")}</th>
            <th className={thCls}>{t("rule")}</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => (
            <tr key={c.field}>
              <td className={`${tdCls} font-mono text-[13px]`}>
                {c.header}
                {c.required && <span className="text-block"> *</span>}
              </td>
              <td className={tdCls}>{t(`rules.${type}.${c.field}`)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-2">
        <a
          className={`${ghostButtonCls} inline-flex items-center`}
          href={`/api/products/import-template?type=${type}`}
        >
          {t("template")}
        </a>
        <input
          ref={file}
          type="file"
          accept=".xlsx,.csv"
          aria-label={t("file")}
          data-testid="product-import-file"
        />
        <button
          type="button"
          className={buttonCls}
          disabled={pending}
          data-testid="product-import-check"
          onClick={() =>
            start(async () => {
              setResult(null);
              const fd = new FormData();
              const f = file.current?.files?.[0];
              if (f) fd.set("file", f);
              setPreview(await previewProductImportAction(connectionId, fd));
            })
          }
        >
          {t("check")}
        </button>
      </div>
      {preview && !preview.ok && <p className="mb-0 mt-2 text-sm text-block">{err(preview.error)}</p>}
      {preview?.ok && (
        <div className="mt-3 flex flex-col gap-2" data-testid="product-import-preview">
          {preview.fileErrors.map((e) => (
            <p key={e} className="m-0 text-sm text-block">
              {err(e)}
              {e === "missing_columns" && preview.missingCols ? `: ${preview.missingCols.join(", ")}` : ""}
            </p>
          ))}
          {rows.length > 0 && (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={thCls}>{t("row")}</th>
                  <th className={thCls}>SKU</th>
                  <th className={thCls}>{t("name")}</th>
                  <th className={thCls}>{t("result")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.row} data-testid="product-import-row">
                    <td className={tdCls}>{r.row}</td>
                    <td className={`${tdCls} font-mono text-[13px]`}>{r.values.sku}</td>
                    <td className={tdCls}>{r.values.name}</td>
                    <td
                      className={`${tdCls} ${r.action === "error" ? "text-block" : r.action === "already" ? "text-muted" : "text-ok"}`}
                    >
                      {r.action === "error" ? r.errors.map(err).join("; ") : t(`action.${r.action}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={buttonCls}
              disabled={pending || ready.length === 0 || (preview.ok && preview.fileErrors.length > 0)}
              data-testid="product-import-apply"
              onClick={() =>
                start(async () => {
                  const r = await applyProductImportAction({
                    connectionId,
                    rows: ready.map((x) => ({ row: x.row, values: x.values })),
                  });
                  setResult(r);
                  if (r.ok) {
                    setPreview(null);
                    router.refresh();
                  }
                })
              }
            >
              {t("apply", { n: ready.length })}
            </button>
          </div>
        </div>
      )}
      {result && (
        <div className="mt-2 text-sm" data-testid="product-import-result">
          {result.ok ? (
            <>
              <p className="m-0 text-ok">
                {t("done", {
                  created: result.created,
                  updated: result.updated,
                  queued: result.queued,
                  already: result.already,
                })}
              </p>
              {result.failed.map((f, i) => (
                <p key={i} className="m-0 text-block">
                  {t("rowFailed", { row: f.row })} {err(f.code)}
                </p>
              ))}
            </>
          ) : (
            <p className="m-0 text-block">{err(result.error)}</p>
          )}
        </div>
      )}
    </details>
  );
}
