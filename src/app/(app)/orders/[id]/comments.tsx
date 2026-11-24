import { getFormatter, getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/PageHeader";
import { can } from "@/server/auth/rbac";
import { listOrderComments } from "@/server/order-comments";
import type { ScopedActor } from "@/server/stores";
import { CommentForm } from "./comment-form";

/** „Коментари“ (owner request 2026-11-24): what the problem is and what was done, with date, time and author. */
export async function OrderComments({ actor, orderId }: { actor: ScopedActor; orderId: string }) {
  const t = await getTranslations("orders.comments");
  const format = await getFormatter();
  const comments = await listOrderComments(actor, orderId);
  return (
    <Card>
      <section aria-label={t("title")} data-testid="order-comments" className="flex flex-col gap-3">
        <h2 className="m-0 text-base font-bold">
          {t("title")} <span className="font-normal text-muted">{comments.length}</span>
        </h2>
        {comments.length === 0 ? (
          <p className="m-0 text-sm text-muted">{t("empty")}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {comments.map((c) => (
              <li
                key={c.id}
                className="rounded-lg border border-line px-3 py-2 text-sm"
                data-testid="order-comment"
              >
                <div className="mb-1 text-xs text-muted">
                  <strong className="text-ink">{c.author}</strong> ·{" "}
                  {format.dateTime(c.createdAt, { dateStyle: "short", timeStyle: "short" })}
                </div>
                <p className="m-0 whitespace-pre-wrap">{c.body}</p>
              </li>
            ))}
          </ol>
        )}
        {can(actor.role, "alerts.manage") && <CommentForm orderId={orderId} />}
      </section>
    </Card>
  );
}
