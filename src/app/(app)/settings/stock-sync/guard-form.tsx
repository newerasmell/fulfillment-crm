"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { saveLineGuardAction } from "@/app/actions/stock";
import { buttonCls, inputCls } from "@/components/ui/form";

/** One product line's anti-sabotage rule: on/off and the two limits. */
export function LineGuardForm({
  lineId,
  guard,
  canEdit,
}: {
  lineId: string;
  guard: { enabled: boolean; maxPerProduct: number | null; maxPerOrder: number | null } | null;
  canEdit: boolean;
}) {
  const t = useTranslations("stockSync.guard");
  const router = useRouter();
  const [enabled, setEnabled] = useState(guard?.enabled ?? false);
  const [perProduct, setPerProduct] = useState(guard?.maxPerProduct?.toString() ?? "");
  const [perOrder, setPerOrder] = useState(guard?.maxPerOrder?.toString() ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const r = await saveLineGuardAction({
        lineId,
        enabled,
        maxPerProduct: perProduct,
        maxPerOrder: perOrder,
      });
      if ("error" in r)
        setMsg({ ok: false, text: t.has(`error.${r.error}`) ? t(`error.${r.error}`) : r.error });
      else {
        setMsg({ ok: true, text: t("saved") });
        router.refresh();
      }
    });
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      aria-label={t("title")}
      data-testid={`guard-${lineId}`}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="inline-flex items-center gap-2 text-sm font-semibold">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!canEdit}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        {t("enabled")}
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        {t("perProduct")}
        <input
          className={`${inputCls} w-28 font-mono`}
          inputMode="numeric"
          value={perProduct}
          disabled={!canEdit}
          onChange={(e) => setPerProduct(e.target.value)}
          aria-label={t("perProduct")}
          placeholder="—"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        {t("perOrder")}
        <input
          className={`${inputCls} w-28 font-mono`}
          inputMode="numeric"
          value={perOrder}
          disabled={!canEdit}
          onChange={(e) => setPerOrder(e.target.value)}
          aria-label={t("perOrder")}
          placeholder="—"
        />
      </label>
      {canEdit && (
        <button type="submit" disabled={pending} className={`${buttonCls} px-3 py-1 text-sm`}>
          {t("save")}
        </button>
      )}
      {msg && (
        <span role="status" className={`text-sm ${msg.ok ? "text-ok" : "text-block"}`}>
          {msg.text}
        </span>
      )}
      <span className="w-full text-xs text-muted">{t("hint")}</span>
    </form>
  );
}
