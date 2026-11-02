import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { MIRROR_PAGE_SIZE } from "@/server/fhb/mirror";

/** Builds a URL of the current screen with some search params replaced (undefined/"" removes one). */
export function hrefWith(
  base: string,
  params: Record<string, string | undefined>,
  over: Record<string, string | undefined>,
) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...over })) if (v) u.set(k, v);
  const s = u.toString();
  return s ? `${base}?${s}` : base;
}

export function FhbChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-fhb-chip px-2 py-0.5 text-[12px] font-semibold text-fhb-text">
      <span aria-hidden className="size-2 rounded-full bg-fhb" />
      FHB
    </span>
  );
}

/** Freshness of one mirror resource: "обновено преди …" or the last error. Never colour only. */
export async function Freshness({
  state,
}: {
  state?: { lastOkAt: Date | null; lastError: string | null; lastRunAt?: Date | null } | null;
}) {
  const t = await getTranslations("fhb");
  const format = await getFormatter();
  if (!state?.lastOkAt && !state?.lastError)
    return <span className="text-sm text-muted">{t("sync.never")}</span>;
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm">
      {state.lastOkAt && (
        <span className="text-muted">
          {t("sync.updated", { at: format.relativeTime(state.lastOkAt, new Date()) })}
        </span>
      )}
      {state.lastError && (
        <span className="rounded-md bg-block-bg px-2 py-0.5 text-block" title={state.lastError}>
          {t("sync.failed")}: {state.lastError.slice(0, 120)}
        </span>
      )}
    </span>
  );
}

export async function Pager({
  base,
  params,
  page,
  total,
}: {
  base: string;
  params: Record<string, string | undefined>;
  page: number;
  total: number;
}) {
  const t = await getTranslations("fhb");
  const pages = Math.max(1, Math.ceil(total / MIRROR_PAGE_SIZE));
  if (pages <= 1) return <p className="m-0 mt-3 text-sm text-muted">{t("pager.total", { total })}</p>;
  return (
    <nav aria-label={t("pager.label")} className="mt-3 flex items-center gap-3 text-sm">
      {page > 1 ? (
        <Link
          href={hrefWith(base, params, { page: String(page - 1) })}
          className="text-accent hover:underline"
        >
          {t("pager.prev")}
        </Link>
      ) : (
        <span className="text-label">{t("pager.prev")}</span>
      )}
      <span className="text-muted">{t("pager.of", { page, pages, total })}</span>
      {page < pages ? (
        <Link
          href={hrefWith(base, params, { page: String(page + 1) })}
          className="text-accent hover:underline"
        >
          {t("pager.next")}
        </Link>
      ) : (
        <span className="text-label">{t("pager.next")}</span>
      )}
    </nav>
  );
}

/** Tab strip: our Bulgarian name with the vendor's original name under it (DESIGN principle 9). */
export function Tabs({
  label,
  items,
}: {
  label: string;
  items: { href: string; title: string; original?: string; active: boolean; count?: number }[];
}) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1 border-b border-line">
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          aria-current={i.active ? "page" : undefined}
          className={`-mb-px flex min-h-11 flex-col justify-center border-b-2 px-3 py-1.5 ${
            i.active ? "border-accent text-accent-strong" : "border-transparent text-ink-2 hover:bg-hover"
          }`}
        >
          <span className="text-[14px] font-semibold">
            {i.title}
            {i.count !== undefined && (
              <span className="ml-1 font-mono text-[12px] text-muted">{i.count}</span>
            )}
          </span>
          {i.original && <span className="text-[11px] text-label">{i.original}</span>}
        </Link>
      ))}
    </nav>
  );
}

export const monoCls = "font-mono text-[13px]";
