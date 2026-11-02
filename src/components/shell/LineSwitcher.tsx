"use client";

import { useTransition } from "react";
import { setLineFilterAction } from "@/app/actions/lines";

/** Sidebar filter above the company filter (P5-00): all lines (OWNER/ADMIN only) or one product line. */
export function LineSwitcher({
  label,
  allLabel,
  current,
  lines,
  mayPickAll,
}: {
  label: string;
  allLabel: string;
  current: string | null;
  lines: { id: string; name: string }[];
  mayPickAll: boolean;
}) {
  const [pending, start] = useTransition();
  return (
    <label className="mb-2 flex min-h-12 w-full flex-col gap-0.5 rounded-[10px] border border-line bg-bg px-2.5 py-2">
      <span className="text-[11px] tracking-wider text-muted uppercase">{label}</span>
      <select
        aria-label={label}
        value={current ?? "all"}
        disabled={pending}
        onChange={(e) => start(() => setLineFilterAction(e.target.value))}
        className="w-full cursor-pointer appearance-none bg-transparent font-semibold text-ink outline-none"
      >
        {mayPickAll && <option value="all">{allLabel}</option>}
        {lines.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );
}
