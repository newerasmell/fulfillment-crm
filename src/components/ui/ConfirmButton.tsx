"use client";

import { useState } from "react";

/** Destructive or production-affecting actions need a second, explicit click (DESIGN.md: safety visible). */
export function ConfirmButton({
  action,
  label,
  confirmLabel,
  cancelLabel,
  prompt,
  tone = "block",
}: {
  action: () => Promise<void>;
  label: string;
  confirmLabel: string;
  cancelLabel: string;
  prompt: string;
  tone?: "block" | "neutral";
}) {
  const [asking, setAsking] = useState(false);
  const strong = tone === "block" ? "bg-block text-white" : "bg-accent text-white";
  if (!asking) {
    return (
      <button
        type="button"
        onClick={() => setAsking(true)}
        className={`min-h-11 rounded-[10px] px-4 font-semibold ${strong}`}
      >
        {label}
      </button>
    );
  }
  return (
    <form action={action} className="flex flex-wrap items-center gap-3" role="group" aria-label={prompt}>
      <span className="font-medium">{prompt}</span>
      <button type="submit" className={`min-h-11 rounded-[10px] px-4 font-semibold ${strong}`}>
        {confirmLabel}
      </button>
      <button
        type="button"
        onClick={() => setAsking(false)}
        className="min-h-11 rounded-[10px] border border-line px-4"
      >
        {cancelLabel}
      </button>
    </form>
  );
}
