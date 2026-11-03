"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { refreshDirectoryAction } from "@/app/actions/directory";
import { ghostButtonCls } from "@/components/ui/form";

/** "Обнови": queues the existing read sync; like JobButton, says it was queued and refreshes a few times. */
export function RefreshButton({ tab }: { tab: string }) {
  const t = useTranslations("directory");
  const router = useRouter();
  const [state, action, pending] = useActionState(refreshDirectoryAction.bind(null, tab), undefined);
  useEffect(() => {
    if (!state?.ok) return;
    const timers = [4_000, 12_000, 30_000, 60_000].map((ms) => setTimeout(() => router.refresh(), ms));
    return () => timers.forEach(clearTimeout);
  }, [state, router]);
  return (
    <form action={action} className="flex items-center gap-2">
      <button type="submit" disabled={pending} className={ghostButtonCls}>
        {t("refresh")}
      </button>
      {state?.ok && (
        <span role="status" className="text-sm text-muted">
          {state.already ? t("jobAlready") : t("jobQueued", { count: state.queued ?? 0 })}
        </span>
      )}
      {state?.error && (
        <span role="status" className="text-sm text-block">
          {t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : t("errors.invalid")}
        </span>
      )}
    </form>
  );
}

/** Copies an office / city / courier code; operators paste it into orders. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const t = useTranslations("directory");
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`${label} ${value}`}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          setDone(false);
        }
      }}
      className="inline-flex min-h-8 items-center rounded-[8px] border border-line bg-surface px-2 text-xs hover:bg-hover"
    >
      {done ? t("copied") : t("copy")}
    </button>
  );
}
