"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  applyImportAction,
  confirmSuggestionAction,
  dismissSuggestionAction,
  linkOtherAction,
  previewImportAction,
  startCatalogueAction,
} from "@/app/actions/lines";
import { buttonCls, ghostButtonCls, inputCls, labelCls } from "@/components/ui/form";
import { LineError } from "../../settings/lines/forms";

/** Re-renders the page every few seconds while a background run is waiting or working. */
export function AutoRefresh({ active, everyMs = 2500 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(id);
  }, [active, everyMs, router]);
  return null;
}

export function StartCatalogueForm({
  lineId,
  connections,
}: {
  lineId: string;
  connections: { id: string; name: string; type: string; count: number }[];
}) {
  const t = useTranslations("lines");
  const [state, action, pending] = useActionState(startCatalogueAction.bind(null, lineId), undefined);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3" aria-label={t("catalogueTitle")}>
      <label className={labelCls}>
        {t("fromWarehouse")}
        <select name="connectionId" required className={`${inputCls} min-w-64`}>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {t("warehouseOption", { name: c.name, count: c.count })}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={pending || connections.length === 0} className={buttonCls}>
        {t("createMasters")}
      </button>
      {state?.ok && (
        <span role="status" className="text-sm text-ok">
          {t("runQueued")}
        </span>
      )}
      <LineError code={state?.error} />
    </form>
  );
}

export function ImportForm({ lineId }: { lineId: string }) {
  const t = useTranslations("lines");
  const [state, action, pending] = useActionState(previewImportAction.bind(null, lineId), undefined);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3" aria-label={t("importTitle")}>
      <label className={labelCls}>
        {t("importFile")}
        <input
          type="file"
          name="file"
          required
          accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className={`${inputCls} py-2`}
        />
      </label>
      <button type="submit" disabled={pending} className={ghostButtonCls}>
        {t("importCheck")}
      </button>
      <LineError code={state?.error} />
    </form>
  );
}

export function ApplyImportForm({ importId, disabled }: { importId: string; disabled: boolean }) {
  const t = useTranslations("lines");
  const [state, action, pending] = useActionState(applyImportAction.bind(null, importId), undefined);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <button type="submit" disabled={disabled || pending || !!state?.ok} className={buttonCls}>
        {t("importApply")}
      </button>
      {state?.ok && (
        <span role="status" className="text-sm text-ok">
          {t("importApplied")}
        </span>
      )}
      <LineError code={state?.error} />
    </form>
  );
}

interface Candidate {
  productId: string;
  sku: string;
  name: string;
  score: number;
  reasons: { kind: "sku" | "barcode" | "name"; value?: number }[];
}

/** One suggestion: Потвърди links it; Друго opens "another SKU" or "not this one". */
export function SuggestionActions({
  lineId,
  kind,
  itemId,
  label,
  candidate,
}: {
  lineId: string;
  kind: "vendor" | "variant";
  itemId: string;
  label: string;
  candidate: Candidate | null;
}) {
  const t = useTranslations("lines");
  const [other, setOther] = useState(!candidate);
  const [confirmState, confirm, confirming] = useActionState(confirmSuggestionAction, undefined);
  const [dismissState, dismiss, dismissing] = useActionState(dismissSuggestionAction, undefined);
  const [otherState, link, linking] = useActionState(linkOtherAction, undefined);
  const hidden = (
    <>
      <input type="hidden" name="lineId" value={lineId} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="itemId" value={itemId} />
    </>
  );
  const error = confirmState?.error ?? dismissState?.error ?? otherState?.error;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {candidate && (
        <form action={confirm}>
          {hidden}
          <input type="hidden" name="productId" value={candidate.productId} />
          <button
            type="submit"
            disabled={confirming}
            className={buttonCls}
            aria-label={t("confirmFor", { item: label, sku: candidate.sku })}
          >
            {t("confirm")}
          </button>
        </form>
      )}
      {candidate && !other && (
        <button type="button" onClick={() => setOther(true)} className={ghostButtonCls}>
          {t("other")}
        </button>
      )}
      {other && (
        <>
          <form action={link} className="flex items-center gap-2" aria-label={t("otherFor", { item: label })}>
            {hidden}
            {candidate && <input type="hidden" name="rejectedProductId" value={candidate.productId} />}
            <input
              name="sku"
              required
              placeholder={t("otherSku")}
              aria-label={t("otherSku")}
              className={`${inputCls} min-h-10 w-40 font-mono`}
            />
            <button type="submit" disabled={linking} className={ghostButtonCls}>
              {t("link")}
            </button>
          </form>
          {candidate && (
            <form action={dismiss}>
              {hidden}
              <input type="hidden" name="productId" value={candidate.productId} />
              <button type="submit" disabled={dismissing} className={ghostButtonCls}>
                {t("notThis")}
              </button>
            </form>
          )}
        </>
      )}
      <LineError code={error} />
    </div>
  );
}
