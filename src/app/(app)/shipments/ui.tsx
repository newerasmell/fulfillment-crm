"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { saveShipmentSettingsAction, type ShipmentActionResult } from "@/app/actions/shipments";
import { buttonCls, inputCls, labelCls } from "@/components/ui/form";

/** "Забавени" threshold: shipped but not delivered after N days (OWNER/ADMIN, audited). */
export function ShipmentSettingsForm({ delayedDays }: { delayedDays: number }) {
  const t = useTranslations("shipmentList");
  const [state, action, pending] = useActionState(saveShipmentSettingsAction, {} as ShipmentActionResult);
  return (
    <form action={action} aria-label={t("settings.form")} className="flex flex-wrap items-end gap-4">
      <label className={labelCls}>
        {t("settings.delayedDays")}
        <input
          name="delayedDays"
          type="number"
          min={1}
          max={60}
          defaultValue={delayedDays}
          className={`${inputCls} w-32`}
        />
      </label>
      <button type="submit" disabled={pending} className={buttonCls}>
        {t("settings.save")}
      </button>
      {state.ok && (
        <span role="status" className="text-sm text-ok">
          {t("settings.saved")}
        </span>
      )}
      {state.error && (
        <span role="alert" className="text-sm text-block">
          {t.has(`error.${state.error}`) ? t(`error.${state.error}`) : state.error}
        </span>
      )}
    </form>
  );
}
