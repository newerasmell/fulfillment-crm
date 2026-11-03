"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";

type Hits = {
  orders: { id: string; number: string; customerName: string | null; status: string }[];
  shipments: {
    id: string;
    externalId: string;
    status: string;
    trackingNumbers: string[];
    connection: { name: string; type: string };
    order: { number: string };
  }[];
};

/**
 * Header search panel (Ctrl/Cmd K): orders by number / customer / phone / e-mail and shipments by tracking
 * number (GET /api/search, same scope as the lists). Enter opens the first hit, or Товарителници searched by
 * the text when there is none.
 */
export function GlobalSearchPanel({ onClose }: { onClose: () => void }) {
  const t = useTranslations("globalSearch");
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hits | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) return;
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(text)}`, { signal: ctrl.signal });
        if (res.ok) setHits((await res.json()) as Hits);
      } catch {
        /* aborted or offline: keep the last hits */
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q]);
  const shown = q.trim().length >= 2 ? hits : null;
  const go = (to: string) => {
    onClose();
    router.push(to);
  };
  const first = shown?.orders[0]
    ? `/orders/${shown.orders[0].id}`
    : shown?.shipments[0]
      ? `/shipments?id=${shown.shipments[0].id}&q=${encodeURIComponent(q.trim())}`
      : null;
  return (
    <>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const text = q.trim();
          if (!text) return;
          go(first ?? `/shipments?q=${encodeURIComponent(text)}`);
        }}
      >
        <label className="flex min-h-11 items-center gap-2 rounded-[10px] border border-line px-3">
          <Icon name="search" size={16} />
          <span className="sr-only">{t("label")}</span>
          <input
            autoFocus
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("placeholder")}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            className="flex-1 bg-transparent outline-none"
            data-testid="global-search-input"
          />
        </label>
      </form>
      {!shown ? (
        <p className="mt-3 text-muted">{t("hint")}</p>
      ) : shown.orders.length === 0 && shown.shipments.length === 0 ? (
        <p className="mt-3 text-muted">{loading ? t("loading") : t("none")}</p>
      ) : (
        <div
          className="mt-3 flex max-h-[50vh] flex-col gap-3 overflow-y-auto"
          data-testid="global-search-results"
        >
          {shown.orders.length > 0 && (
            <section>
              <h3 className="m-0 mb-1 text-xs font-semibold tracking-wide text-label uppercase">
                {t("orders")}
              </h3>
              <ul className="m-0 flex list-none flex-col p-0">
                {shown.orders.map((o) => (
                  <li key={o.id}>
                    <Link
                      href={`/orders/${o.id}`}
                      onClick={onClose}
                      className="flex min-h-10 items-center gap-2 rounded-lg px-2 text-ink no-underline hover:bg-hover"
                    >
                      <span className="font-mono">{o.number}</span>
                      <span className="truncate text-sm text-muted">{o.customerName ?? ""}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {shown.shipments.length > 0 && (
            <section>
              <h3 className="m-0 mb-1 text-xs font-semibold tracking-wide text-label uppercase">
                {t("shipments")}
              </h3>
              <ul className="m-0 flex list-none flex-col p-0">
                {shown.shipments.map((s) => (
                  <li key={s.id}>
                    <Link
                      href={`/shipments?id=${s.id}&q=${encodeURIComponent(q.trim())}`}
                      onClick={onClose}
                      className="flex min-h-10 items-center gap-2 rounded-lg px-2 text-ink no-underline hover:bg-hover"
                    >
                      <span
                        aria-hidden
                        className={`size-2 rounded-full ${s.connection.type === "EUSHIPMENTS" ? "bg-eu" : "bg-fhb"}`}
                      />
                      <span className="font-mono">{s.trackingNumbers[0] ?? s.externalId}</span>
                      <span className="truncate text-sm text-muted">
                        {s.order.number} · {s.connection.name}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </>
  );
}
