import { getTranslations } from "next-intl/server";

const TONE: Record<string, string> = {
  IMPORTED: "bg-accent-soft text-accent-strong",
  CHECKING: "bg-accent-soft text-accent-strong",
  NEEDS_REVIEW: "bg-warn-bg text-warn",
  READY: "bg-ok-bg text-ok",
  APPROVED: "bg-ok-bg text-ok",
  BLOCKED: "bg-block-bg text-block",
  ON_HOLD: "bg-warn-bg text-warn",
  SUBMIT_FAILED: "bg-block-bg text-block",
  EXCEPTION: "bg-block-bg text-block",
  CANCELLED: "bg-hover text-muted line-through",
};

export async function StatusChip({ status }: { status: string }) {
  const t = await getTranslations("orderStatus");
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${TONE[status] ?? "bg-hover text-ink-2"}`}
    >
      {t(status)}
    </span>
  );
}
