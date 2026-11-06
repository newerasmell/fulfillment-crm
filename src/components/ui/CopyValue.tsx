"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CopyIcon } from "./icons";

/** A value that copies itself to the clipboard on click (customer, address and item fields). */
export function CopyValue({
  value,
  children,
  mono = false,
  className = "",
}: {
  value: string;
  children?: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  const t = useTranslations("common");
  const [done, setDone] = useState(false);
  return (
    <span
      role="button"
      tabIndex={0}
      title={t("clickToCopy")}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          setDone(false);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") (e.currentTarget as HTMLElement).click();
      }}
      className={`group -ml-1.5 inline-flex max-w-full cursor-copy items-center gap-1.5 rounded-md px-1.5 py-0.5 break-words hover:bg-hover ${mono ? "font-mono text-[13px]" : ""} ${className}`}
    >
      <span className="min-w-0">{children ?? value}</span>
      {done ? (
        <span className="rounded-full bg-ok-bg px-1.5 py-px font-sans text-[11px] font-medium whitespace-nowrap text-ok">
          ✓ {t("copied")}
        </span>
      ) : (
        <span className="text-label opacity-0 group-hover:opacity-100 group-focus:opacity-100">
          <CopyIcon />
        </span>
      )}
    </span>
  );
}
