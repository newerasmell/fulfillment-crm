"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { saveEscalationSettingsAction } from "@/app/actions/warehouse-cases";
import { buttonCls, inputCls, labelCls } from "@/components/ui/form";
import { CUSTOMER_PLACEHOLDERS } from "@/lib/warehouse-case-emails";

interface Values {
  companyId: string;
  senderEmail: string;
  warehouseTo: string;
  warehouseCc: string;
  escalationTo: string;
  flagHours: number;
  firstEmailHours: number;
  reminderHours: number;
  decisionHours: number;
  workDaysOnly: boolean;
  discountPercent: string;
  customerSubject: string;
  customerBody: string;
}

export function EscalationForm({
  s,
  canEdit,
  defaults,
}: {
  s: Values;
  canEdit: boolean;
  defaults: { subject: string; body: string };
}) {
  const t = useTranslations("warehouseEmails");
  const router = useRouter();
  const [v, setV] = useState(s);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof Values>(k: K, value: Values[K]) => setV((prev) => ({ ...prev, [k]: value }));
  const text = (k: "senderEmail" | "warehouseTo" | "warehouseCc" | "escalationTo", wide = false) => (
    <label className={`${labelCls} ${wide ? "md:col-span-2" : ""}`}>
      <span>{t(`field.${k}`)}</span>
      <input
        className={inputCls}
        value={v[k]}
        disabled={!canEdit}
        maxLength={4000}
        placeholder={t(`placeholder.${k}`)}
        onChange={(e) => set(k, e.target.value)}
        data-testid={`esc-${k}`}
      />
      <span className="text-xs font-normal text-muted">{t(`hint.${k}`)}</span>
    </label>
  );
  const hours = (k: "flagHours" | "firstEmailHours" | "reminderHours" | "decisionHours") => (
    <label className={labelCls}>
      <span>{t(`field.${k}`)}</span>
      <input
        className={inputCls}
        type="number"
        min={1}
        max={336}
        value={v[k]}
        disabled={!canEdit}
        onChange={(e) => set(k, Number(e.target.value))}
        data-testid={`esc-${k}`}
      />
    </label>
  );
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="escalation-form"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveEscalationSettingsAction(v);
          if ("error" in r)
            setMsg({ ok: false, text: t.has(`error.${r.error}`) ? t(`error.${r.error}`) : r.error });
          else {
            setMsg({ ok: true, text: t("saved") });
            router.refresh();
          }
        });
      }}
    >
      <div className="grid gap-3 md:grid-cols-2">
        {text("senderEmail")}
        {text("warehouseTo")}
        {text("warehouseCc")}
        {text("escalationTo")}
      </div>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-sm font-semibold">{t("hoursTitle")}</legend>
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
          {hours("flagHours")}
          {hours("firstEmailHours")}
          {hours("reminderHours")}
          {hours("decisionHours")}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={v.workDaysOnly}
            disabled={!canEdit}
            onChange={(e) => set("workDaysOnly", e.target.checked)}
          />
          {t("field.workDaysOnly")}
        </label>
      </fieldset>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-sm font-semibold">{t("customerTitle")}</legend>
        <label className={`${labelCls} max-w-xs`}>
          <span>{t("field.discountPercent")}</span>
          <input
            className={inputCls}
            type="number"
            min={1}
            max={90}
            value={v.discountPercent}
            disabled={!canEdit}
            onChange={(e) => set("discountPercent", e.target.value)}
            data-testid="esc-discountPercent"
          />
        </label>
        <label className={labelCls}>
          <span>{t("field.customerSubject")}</span>
          <input
            className={inputCls}
            value={v.customerSubject}
            disabled={!canEdit}
            maxLength={300}
            placeholder={defaults.subject}
            onChange={(e) => set("customerSubject", e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span>{t("field.customerBody")}</span>
          <textarea
            className={`${inputCls} min-h-56 py-2 font-mono text-[13px]`}
            value={v.customerBody}
            disabled={!canEdit}
            maxLength={5000}
            placeholder={defaults.body}
            onChange={(e) => set("customerBody", e.target.value)}
          />
          <span className="text-xs font-normal text-muted">
            {t("hint.customerBody", { placeholders: CUSTOMER_PLACEHOLDERS.map((p) => `{${p}}`).join(" ") })}
          </span>
        </label>
      </fieldset>
      {canEdit && (
        <div className="flex items-center gap-3">
          <button type="submit" className={buttonCls} disabled={pending} data-testid="esc-save">
            {t("save")}
          </button>
          {msg && <span className={`text-sm ${msg.ok ? "text-ok" : "text-block"}`}>{msg.text}</span>}
        </div>
      )}
    </form>
  );
}
