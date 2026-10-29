import { getFormatter, getTranslations } from "next-intl/server";
import { redriveAction } from "@/app/actions/jobs";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, tdCls, thCls } from "@/components/ui/form";
import { requireAccountContext } from "@/server/auth/session";
import { webBoss } from "@/server/jobs/boss";
import { listDeadLetters, type DeadLetterView } from "@/server/jobs/dead-letters";
import { logger } from "@/lib/logger";

export default async function JobsPage() {
  const ctx = await requireAccountContext("jobs.admin");
  const t = await getTranslations("jobs");
  const format = await getFormatter();
  let rows: DeadLetterView[] = [];
  let unavailable = false;
  try {
    rows = await listDeadLetters(await webBoss(), ctx.accountId);
  } catch (err) {
    // The worker installs the queue schema; before its first start there is nothing to show.
    logger.warn({ err }, "dead letters unavailable");
    unavailable = true;
  }
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("intro")} />
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("deadLetters")}</h2>
        {rows.length === 0 ? (
          <p className="m-0 text-muted">{unavailable ? "—" : t("empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>{t("queue")}</th>
                  <th className={thCls}>{t("created")}</th>
                  <th className={thCls}>{t("attempts")}</th>
                  <th className={thCls}>{t("error")}</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody>
                {rows.map((j) => (
                  <tr key={j.id}>
                    <td className={`${tdCls} font-mono text-[13px]`}>{j.sourceQueue ?? "—"}</td>
                    <td className={`${tdCls} font-mono text-[13px] whitespace-nowrap`}>
                      {format.dateTime(j.createdOn, { dateStyle: "short", timeStyle: "medium" })}
                    </td>
                    <td className={`${tdCls} font-mono`}>{j.retryCount}</td>
                    <td className={`${tdCls} max-w-md truncate text-block`}>{j.error}</td>
                    <td className={tdCls}>
                      <form action={redriveAction.bind(null, j.id)}>
                        <button type="submit" className={ghostButtonCls}>
                          {t("retry")}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
