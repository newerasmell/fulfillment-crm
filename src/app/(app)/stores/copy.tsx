"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

/** A value to paste into the Shopify Dev Dashboard, with a copy button. */
export function CopyValue({ value, label }: { value: string; label: string }) {
  const t = useTranslations("stores.setup");
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <code
        className="block flex-1 rounded-md border border-line bg-hover px-2 py-1 font-mono text-[12px] break-all"
        data-testid={`copy-value-${label}`}
      >
        {value}
      </code>
      <button
        type="button"
        aria-label={`${t("copy")} ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setDone(true);
            setTimeout(() => setDone(false), 2000);
          } catch {
            setDone(false);
          }
        }}
        className="inline-flex min-h-8 shrink-0 items-center rounded-[8px] border border-line bg-surface px-2 text-xs hover:bg-hover"
      >
        {done ? t("copied") : t("copy")}
      </button>
    </div>
  );
}
