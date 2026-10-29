"use client";

import { useTransition } from "react";
import { switchAccountAction } from "@/app/actions/session";

export function AccountSwitcher({
  label,
  current,
  accounts,
}: {
  label: string;
  current: string;
  accounts: { accountId: string; accountName: string }[];
}) {
  const [pending, start] = useTransition();
  return (
    <label className="mb-2 flex min-h-12 w-full flex-col gap-0.5 rounded-[10px] border border-line bg-bg px-2.5 py-2">
      <span className="text-[11px] tracking-wider text-muted uppercase">{label}</span>
      <select
        aria-label={label}
        value={current}
        disabled={pending}
        onChange={(e) => start(() => switchAccountAction(e.target.value))}
        className="w-full cursor-pointer appearance-none bg-transparent font-semibold text-ink outline-none"
      >
        {accounts.map((a) => (
          <option key={a.accountId} value={a.accountId}>
            {a.accountName}
          </option>
        ))}
      </select>
    </label>
  );
}
