import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { requireAccountContext } from "@/server/auth/session";

const ATTENTION = ["review", "blocked", "errors", "returns", "tickets", "stockouts"] as const;

export default async function HomePage() {
  const ctx = await requireAccountContext();
  const t = await getTranslations();
  const format = await getFormatter();
  const today = format.dateTime(new Date(), { weekday: "long", day: "numeric", month: "long" });
  return (
    <>
      <PageHeader title={t("pages.home.title")} subtitle={`${today} · ${ctx.accountName}`} />
      <section aria-labelledby="attention" className="flex flex-col gap-3">
        <h2 id="attention" className="m-0 text-base font-semibold">
          {t("pages.home.attention")}
        </h2>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          {ATTENTION.map((k) => (
            <Link
              key={k}
              href="/orders"
              className="flex min-h-24 flex-col justify-between rounded-[var(--radius-card)] border border-line bg-surface p-4 text-ink no-underline hover:border-[#C9CFEA]"
            >
              <span className="text-[13px] text-muted">{t(`attention.${k}`)}</span>
              <span className="font-mono text-3xl font-semibold">0</span>
            </Link>
          ))}
        </div>
      </section>
      <Card>
        <p className="m-0 text-muted">{t("pages.home.empty")}</p>
      </Card>
    </>
  );
}
