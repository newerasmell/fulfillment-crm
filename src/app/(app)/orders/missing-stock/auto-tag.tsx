"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { setOutOfStockAutoTagAction } from "@/app/actions/review";

/** Per store: put out_of_stock on new orders no warehouse can fill (owner request 2026-11-11). */
export function AutoTagSettings({
  stores,
  canEdit,
}: {
  stores: { id: string; name: string; enabled: boolean; readOnly: boolean }[];
  canEdit: boolean;
}) {
  const t = useTranslations("missingStock.auto");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toggle = (storeId: string, enabled: boolean) =>
    start(async () => {
      const r = await setOutOfStockAutoTagAction({ storeId, enabled });
      if ("error" in r) setError(r.error);
      else {
        setError(null);
        router.refresh();
      }
    });
  return (
    <details className="mb-3" data-testid="auto-tag-settings">
      <summary className="cursor-pointer text-sm font-semibold">
        {t("title", { n: stores.filter((s) => s.enabled).length })}
      </summary>
      <p className="m-0 my-2 text-sm text-muted">{t("hint")}</p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {stores.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={s.enabled}
                disabled={!canEdit || pending}
                onChange={(e) => toggle(s.id, e.target.checked)}
              />
              {s.name}
            </label>
            {s.enabled && s.readOnly && <span className="text-xs text-warn">{t("readOnly")}</span>}
          </li>
        ))}
      </ul>
      {error && <p className="m-0 mt-1 text-sm text-block">{error}</p>}
    </details>
  );
}
