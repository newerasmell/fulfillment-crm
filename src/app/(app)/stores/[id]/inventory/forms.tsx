"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import {
  activateLocationAction,
  mapLocationAction,
  pushInventoryNowAction,
  readShopifyInventoryAction,
} from "@/app/actions/stock";
import { StockError } from "@/app/(app)/products/stock/forms";
import { buttonCls, ghostButtonCls, inputCls } from "@/components/ui/form";

export function MapLocationForm({
  storeId,
  locationId,
  locationName,
  current,
  connections,
  disabled,
}: {
  storeId: string;
  locationId: string;
  locationName: string;
  current: string | null;
  connections: { id: string; name: string }[];
  disabled: boolean;
}) {
  const t = useTranslations("stock.push");
  const [state, action, pending] = useActionState(mapLocationAction.bind(null, storeId), undefined);
  return (
    <form
      action={action}
      className="flex flex-wrap items-center gap-2"
      aria-label={t("mapFor", { name: locationName })}
    >
      <input type="hidden" name="locationId" value={locationId} />
      <select
        name="connectionId"
        defaultValue={current ?? ""}
        disabled={disabled}
        aria-label={t("warehouseFor", { name: locationName })}
        className={inputCls}
      >
        <option value="">{t("notMapped")}</option>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {!disabled && (
        <button type="submit" disabled={pending} className={ghostButtonCls}>
          {t("save")}
        </button>
      )}
      {state?.ok && (
        <span role="status" className="text-sm text-ok">
          {t("saved")}
        </span>
      )}
      <StockError code={state?.error} />
    </form>
  );
}

export function ReadInventoryButton({ storeId }: { storeId: string }) {
  const t = useTranslations("stock.push");
  const [state, action, pending] = useActionState(readShopifyInventoryAction.bind(null, storeId), undefined);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <button type="submit" disabled={pending} className={ghostButtonCls}>
        {t("readNow")}
      </button>
      {state?.ok && (
        <span role="status" className="text-sm text-ok">
          {t("readQueued")}
        </span>
      )}
      <StockError code={state?.error} />
    </form>
  );
}

export function PushNowButton({
  storeId,
  mode,
  changes,
}: {
  storeId: string;
  mode: string;
  changes: number;
}) {
  const t = useTranslations("stock.push");
  const [state, action, pending] = useActionState(pushInventoryNowAction.bind(null, storeId), undefined);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <button type="submit" disabled={pending || mode === "DISABLED" || changes === 0} className={buttonCls}>
        {mode === "LIVE" ? t("pushLive", { n: changes }) : t("pushDryRun", { n: changes })}
      </button>
      {state?.ok && (
        <span role="status" className="text-sm text-ok">
          {t("pushQueued")}
        </span>
      )}
      <StockError code={state?.error} />
    </form>
  );
}

/**
 * "Активирай продуктите в тази локация (N)" (OWNER): a second click confirms the count. The job goes through the
 * worker; the store's push mode decides at send time (DRY_RUN records the requests shown below, LIVE sends).
 */
export function ActivateLocationButton({
  storeId,
  locationId,
  locationName,
  count,
  mode,
}: {
  storeId: string;
  locationId: string;
  locationName: string;
  count: number;
  mode: string;
}) {
  const t = useTranslations("stock.push");
  const [confirming, setConfirming] = useState(false);
  const [state, action, pending] = useActionState(activateLocationAction.bind(null, storeId), undefined);
  const disabled = pending || count === 0 || mode === "DISABLED";
  return (
    <form
      action={(f) => {
        setConfirming(false);
        return action(f);
      }}
      className="mt-2 flex flex-wrap items-center gap-2"
      aria-label={t("activateFor", { name: locationName })}
    >
      <input type="hidden" name="locationId" value={locationId} />
      <input type="hidden" name="expected" value={count} />
      {!confirming ? (
        <button
          type="button"
          disabled={disabled}
          className={ghostButtonCls}
          onClick={() => setConfirming(true)}
        >
          {t("activate", { n: count })}
        </button>
      ) : (
        <>
          <span className="text-sm">
            {mode === "LIVE" ? t("activateConfirmLive", { n: count }) : t("activateConfirmDry", { n: count })}
          </span>
          <button type="submit" disabled={disabled} className={buttonCls}>
            {t("activateConfirm", { n: count })}
          </button>
          <button type="button" className={ghostButtonCls} onClick={() => setConfirming(false)}>
            {t("cancel")}
          </button>
        </>
      )}
      {state?.ok && (
        <span role="status" className="text-sm text-ok">
          {t("activateQueued")}
        </span>
      )}
      <StockError code={state?.error} />
    </form>
  );
}
