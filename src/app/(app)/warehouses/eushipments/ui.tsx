import { getFormatter, getTranslations } from "next-intl/server";

/** Warehouse identity: colour always with the name next to it (DESIGN.md principle 3). */
export function WarehouseChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-eu-chip px-2 py-0.5 text-xs font-semibold text-eu-text">
      <span aria-hidden className="inline-block size-2 rounded-full bg-eu" />
      euShipments
    </span>
  );
}

export async function TestBadge({
  sync,
}: {
  sync?: { lastOkAt: Date | null; lastError: string | null } | null;
}) {
  const t = await getTranslations("eushipments");
  if (!sync || (!sync.lastOkAt && !sync.lastError))
    return <span className="rounded-full bg-hover px-2 py-0.5 text-xs text-muted">{t("testPending")}</span>;
  if (sync.lastError)
    return (
      <span className="rounded-full bg-block-bg px-2 py-0.5 text-xs text-block">
        {t("testFailed")}:{" "}
        {t.has(`errors.${sync.lastError}`) ? t(`errors.${sync.lastError}`) : sync.lastError}
      </span>
    );
  return <span className="rounded-full bg-ok-bg px-2 py-0.5 text-xs text-ok">{t("testOk")}</span>;
}

/** Age of a snapshot ("преди 12 мин"), so every number shows how fresh it is (DESIGN.md principle 8). */
export async function Freshness({ at }: { at: Date | null }) {
  const t = await getTranslations("eushipments");
  const format = await getFormatter();
  if (!at) return <span className="text-muted">{t("never")}</span>;
  return (
    <time dateTime={at.toISOString()} title={format.dateTime(at, { dateStyle: "short", timeStyle: "short" })}>
      {format.relativeTime(at)}
    </time>
  );
}

/** Our Bulgarian name with the vendor's original name under it (DESIGN.md principle 9). */
export function TabLabel({ bg, original }: { bg: string; original: string }) {
  return (
    <span className="flex flex-col leading-tight">
      <span>{bg}</span>
      <span className="text-[11px] font-normal text-muted">{original}</span>
    </span>
  );
}
