import { getFormatter, getTranslations } from "next-intl/server";

export async function ConnectionBadge({ status }: { status: unknown }) {
  const t = await getTranslations("stores");
  const format = await getFormatter();
  const s = (status ?? {}) as { ok?: boolean; at?: string; error?: string };
  if (s.ok === undefined) {
    return (
      <span className="rounded-full bg-hover px-2 py-0.5 text-xs text-muted">{t("status.pending")}</span>
    );
  }
  const at = s.at ? format.dateTime(new Date(s.at), { dateStyle: "short", timeStyle: "short" }) : "";
  return s.ok ? (
    <span className="rounded-full bg-ok-bg px-2 py-0.5 text-xs text-ok" title={at}>
      {t("status.ok")}
    </span>
  ) : (
    <span className="rounded-full bg-block-bg px-2 py-0.5 text-xs text-block" title={at}>
      {t("status.failed")}: {t.has(`errors.${s.error}`) ? t(`errors.${s.error}`) : s.error}
    </span>
  );
}
