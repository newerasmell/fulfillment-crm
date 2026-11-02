"use client";

import { useTransition } from "react";
import { setCompanyFilterAction } from "@/app/actions/companies";

/** Sidebar filter: all companies of the group the member may see, or one of them. */
export function CompanySwitcher({
  label,
  allLabel,
  current,
  companies,
}: {
  label: string;
  allLabel: string;
  current: string | null;
  companies: { id: string; name: string }[];
}) {
  const [pending, start] = useTransition();
  return (
    <label className="mb-2 flex min-h-12 w-full flex-col gap-0.5 rounded-[10px] border border-line bg-bg px-2.5 py-2">
      <span className="text-[11px] tracking-wider text-muted uppercase">{label}</span>
      <select
        aria-label={label}
        value={current ?? "all"}
        disabled={pending}
        onChange={(e) => start(() => setCompanyFilterAction(e.target.value))}
        className="w-full cursor-pointer appearance-none bg-transparent font-semibold text-ink outline-none"
      >
        {companies.length !== 1 && <option value="all">{allLabel}</option>}
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}
