"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { saveMyStoresAction } from "@/app/actions/store-preferences";
import { buttonCls } from "@/components/ui/form";
import type { StoreGroups } from "@/server/store-preferences";

export function MyStoresForm({ groups, selected }: { groups: StoreGroups; selected: string[] }) {
  const t = useTranslations("myStores");
  const [picked, setPicked] = useState<Set<string>>(new Set(selected));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const toggle = (ids: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids)
        if (on) next.add(id);
        else next.delete(id);
      return next;
    });
  return (
    <form
      className="flex flex-col gap-4"
      aria-label={t("title")}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveMyStoresAction([...picked]);
          setMsg(
            "error" in r ? { ok: false, text: t("failed") } : { ok: true, text: t("saved", { n: r.count }) },
          );
        });
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        {groups.map((g) => {
          const ids = g.stores.map((s) => s.id);
          const every = ids.length > 0 && ids.every((id) => picked.has(id));
          return (
            <fieldset
              key={g.lineId ?? "none"}
              className="m-0 flex flex-col gap-1 rounded-lg border border-line p-3"
            >
              <legend className="px-1 text-sm font-semibold">{g.line ?? t("noLine")}</legend>
              <label className="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={every} onChange={(e) => toggle(ids, e.target.checked)} />
                {t("wholeLine")}
              </label>
              {g.stores.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={picked.has(s.id)}
                    onChange={(e) => toggle([s.id], e.target.checked)}
                  />
                  {s.name}
                </label>
              ))}
            </fieldset>
          );
        })}
      </div>
      <p className="m-0 text-xs text-muted">{t("hint")}</p>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonCls}>
          {t("save")}
        </button>
        {msg && (
          <span className={msg.ok ? "text-ok" : "text-block"} role="status">
            {msg.text}
          </span>
        )}
      </div>
    </form>
  );
}
