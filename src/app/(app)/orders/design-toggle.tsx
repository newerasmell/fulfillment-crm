"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { setOrderDesignAction } from "@/app/actions/preferences";
import type { OrderDesign } from "@/server/preferences";

/** "Изглед: Класически | Нов" in the order page header; the choice is saved for the signed-in person. */
export function DesignToggle({ current }: { current: OrderDesign }) {
  const t = useTranslations("orders.design");
  const router = useRouter();
  const [pending, start] = useTransition();
  const pick = (d: OrderDesign) => {
    if (d === current || pending) return;
    start(async () => {
      const r = await setOrderDesignAction(d);
      if (!r?.error) router.refresh();
    });
  };
  const opt = (d: OrderDesign, label: React.ReactNode) => (
    <button
      type="button"
      role="radio"
      aria-checked={current === d}
      disabled={pending}
      onClick={() => pick(d)}
      className={`inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[13px] font-medium ${
        current === d ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-col items-end gap-1" data-testid="design-toggle">
      <div className="flex items-center gap-2">
        <span className="text-xs text-label" id="design-toggle-label">
          {t("label")}
        </span>
        <div
          role="radiogroup"
          aria-labelledby="design-toggle-label"
          className={`inline-flex items-center gap-0.5 rounded-[10px] bg-[#ebebe6] p-[3px] ${pending ? "opacity-60" : ""}`}
        >
          {opt("classic", t("classic"))}
          {opt(
            "new",
            <>
              {t("new")}
              <span className="rounded-full bg-accent-soft px-1.5 text-[10px] font-bold text-accent">
                {t("newBadge")}
              </span>
            </>,
          )}
        </div>
      </div>
      <span className="text-xs text-label">{t("saved")}</span>
    </div>
  );
}
