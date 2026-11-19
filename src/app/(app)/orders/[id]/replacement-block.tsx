import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ghostButtonCls } from "@/components/ui/form";
import { replacementLinks } from "@/server/labels/replacement";
import type { ScopedActor } from "@/server/stores";

/**
 * „Изпрати замяна“ on the order page (owner request 2026-11-19): a free resend starts from this order; the
 * replacements already sent, and for a replacement the order it was sent for, are linked.
 */
export async function ReplacementBlock({
  actor,
  orderId,
  canSend,
}: {
  actor: Pick<ScopedActor, "accountId" | "companyScope">;
  orderId: string;
  canSend: boolean;
}) {
  const t = await getTranslations("manual.replacement");
  const { replacements, replacementOf } = await replacementLinks(actor, orderId);
  const why = (r: { reason: string; reasonText: string | null }) =>
    r.reason === "other" && r.reasonText ? r.reasonText : t(`reasons.${r.reason}`);
  if (!canSend && !replacements.length && !replacementOf) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm" data-testid="replacement-block">
      {replacementOf && (
        <span className="rounded-lg bg-accent-soft px-3 py-1.5" data-testid="replacement-of">
          {t("isReplacementOf")}{" "}
          <Link className="font-semibold underline" href={`/orders/${replacementOf.id}`}>
            {replacementOf.number}
          </Link>{" "}
          · {why(replacementOf)}
        </span>
      )}
      {replacements.length > 0 && (
        <span className="rounded-lg bg-accent-soft px-3 py-1.5" data-testid="replacements">
          {t("sentReplacements")}{" "}
          {replacements.map((r, i) => (
            <span key={r.id}>
              {i > 0 && ", "}
              <Link className="font-semibold underline" href={`/orders/${r.id}`}>
                {r.number}
              </Link>{" "}
              ({why(r)})
            </span>
          ))}
        </span>
      )}
      {canSend && (
        <Link
          className={`${ghostButtonCls} inline-flex items-center`}
          href={`/manual-shipments/new?from=${orderId}`}
          data-testid="replacement-send"
        >
          {t("send")}
        </Link>
      )}
    </div>
  );
}
