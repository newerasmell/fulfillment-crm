"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { runStoreJobAction } from "@/app/actions/stores";
import { ghostButtonCls } from "@/components/ui/form";

/** Background jobs give no instant result: say it was queued and refresh the page a few times to show it. */
export function JobButton({
  storeId,
  kind,
  label,
}: {
  storeId: string;
  kind: "test" | "orders" | "products" | "webhooks";
  label: string;
}) {
  const t = useTranslations("stores");
  const router = useRouter();
  const [state, action, pending] = useActionState(runStoreJobAction.bind(null, storeId, kind), undefined);
  useEffect(() => {
    if (!state?.ok) return;
    const timers = [4_000, 12_000, 30_000, 60_000].map((ms) => setTimeout(() => router.refresh(), ms));
    return () => timers.forEach(clearTimeout);
  }, [state, router]);
  return (
    <form action={action} className="flex items-center gap-2">
      <button type="submit" disabled={pending} className={ghostButtonCls}>
        {label}
      </button>
      {state?.ok && (
        <span role="status" className="text-sm text-muted">
          {state.already ? t("jobAlready") : t("jobQueued")}
        </span>
      )}
      {state?.error && (
        <span role="status" className="text-sm text-block">
          {t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : state.error}
        </span>
      )}
    </form>
  );
}
