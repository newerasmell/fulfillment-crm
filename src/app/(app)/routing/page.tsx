import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { deleteRoutingRuleAction, moveRoutingRuleAction } from "@/app/actions/routing";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, inputCls, tdCls, thCls } from "@/components/ui/form";
import type { ConnectionType } from "@/generated/prisma/client";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { companyFilter } from "@/server/companies";
import { accountDb } from "@/server/db/client";
import {
  describeMatch,
  listRoutingRules,
  routeOrder,
  STOCK_CONNECTION_TYPES,
  type RoutingDecision,
} from "@/server/routing";
import { EMPTY_RULE, RuleForm, type RuleFormValues } from "./forms";

/** Настройки → Правила за маршрут (P4-02): ordered rules, first match wins, stock fallback. OWNER/ADMIN. */

function WarehouseChip({ type, name }: { type: ConnectionType; name: string }) {
  const cls = type === "EUSHIPMENTS" ? "bg-eu-chip text-eu-text" : "bg-fhb-chip text-fhb-text";
  const dot = type === "EUSHIPMENTS" ? "bg-eu" : "bg-fhb";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold ${cls}`}
    >
      <span aria-hidden className={`size-2 rounded-full ${dot}`} />
      {name}
    </span>
  );
}

export default async function RoutingPage({ searchParams }: { searchParams: Promise<{ order?: string }> }) {
  const ctx = await requireAccountContext("routing.manage");
  const t = await getTranslations("routing");
  const lang = (await getLocale()) === "en" ? "en" : "bg";
  const actor = actorFrom(ctx);
  const db = accountDb(ctx.accountId);
  const inScope = (companyId: string | null) =>
    !ctx.companyScope || (!!companyId && ctx.companyScope.includes(companyId));

  const [rules, connections, stores] = await Promise.all([
    listRoutingRules(actor),
    db.fulfillmentConnection.findMany({
      where: { type: { in: [...STOCK_CONNECTION_TYPES] } },
      select: {
        id: true,
        name: true,
        type: true,
        companyId: true,
        enabled: true,
        company: { select: { name: true } },
      },
      orderBy: { name: "asc" },
    }),
    db.store.findMany({
      select: { id: true, code: true, name: true, companyId: true },
      orderBy: { code: "asc" },
    }),
  ]);
  const myConnections = connections.filter((c) => inScope(c.companyId));
  const myStores = stores.filter((s) => inScope(s.companyId));
  const storeCodes = new Map(stores.map((s) => [s.id, s.code]));
  const productIds = [...new Set(rules.flatMap((r) => r.matchParsed?.productIds ?? []))];
  const skuOf = new Map(
    (productIds.length
      ? await db.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true } })
      : []
    ).map((p) => [p.id, p.sku]),
  );

  const connectionOptions = myConnections.map((c) => ({
    id: c.id,
    label: `${c.name}${c.company ? ` · ${c.company.name}` : ""}${c.enabled ? "" : ` (${t("disabled")})`}`,
  }));
  const storeOptions = myStores.map((s) => ({ id: s.id, label: `${s.code} · ${s.name}` }));

  // "Try an order": the decision and every rule's outcome, for one order number.
  const sp = await searchParams;
  const number = sp.order?.trim();
  let tried: { id: string; number: string; decision: RoutingDecision }[] | null = null;
  if (number) {
    const candidates = await db.order.findMany({
      where: { ...companyFilter(ctx), number: { in: [number, `#${number.replace(/^#/, "")}`] } },
      select: { id: true, number: true },
      take: 5,
    });
    tried = await Promise.all(
      candidates.map(async (o) => ({ ...o, decision: await routeOrder(ctx.accountId, o.id) })),
    );
  }

  const valuesOf = (r: (typeof rules)[number]): RuleFormValues => {
    const m = r.matchParsed ?? {};
    return {
      id: r.id,
      name: r.name,
      connectionId: r.connectionId,
      enabled: r.enabled,
      storeIds: m.storeIds ?? [],
      countries: (m.countries ?? []).join(", "),
      payment: m.payment ?? "",
      tags: (m.tags ?? []).join(", "),
      excludeTags: (m.excludeTags ?? []).join(", "),
      skus: (m.productIds ?? []).map((p) => skuOf.get(p) ?? p).join(", "),
      requireStock: !!m.requireStock,
      parcelService: r.parcelService ?? "",
      courierId: r.courierId ?? "",
      serviceName: r.serviceName ?? "",
      deliveryPointPolicy: r.deliveryPointPolicy ?? "",
    };
  };

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("intro")} />
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("listTitle")}</h2>
        <p className="mt-0 text-sm text-muted">{t("howItWorks")}</p>
        {rules.length === 0 ? (
          <p className="m-0 text-muted">{t("empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" aria-label={t("listTitle")}>
              <thead>
                <tr>
                  <th className={thCls}>#</th>
                  <th className={thCls}>{t("name")}</th>
                  <th className={thCls}>{t("conditions")}</th>
                  <th className={thCls}>{t("connection")}</th>
                  <th className={thCls}>{t("carrier")}</th>
                  <th className={thCls}>{t("state")}</th>
                  <th className={thCls}>{t("actions")}</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r, i) => (
                  <tr key={r.id} className="align-top">
                    <td className={`${tdCls} font-mono`}>{r.number}</td>
                    <td className={`${tdCls} font-medium`}>{r.name}</td>
                    <td className={tdCls}>
                      {r.matchParsed ? describeMatch(r.matchParsed, storeCodes, lang) : t("invalidMatch")}
                      {r.matchParsed?.requireStock && (
                        <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-[12px] text-accent-strong">
                          {t("requireStockShort")}
                        </span>
                      )}
                    </td>
                    <td className={tdCls}>
                      <WarehouseChip type={r.connection.type} name={r.connection.name} />
                    </td>
                    <td className={`${tdCls} font-mono text-[13px]`}>
                      {[r.parcelService, r.courierId, r.serviceName].filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td className={tdCls}>{r.enabled ? t("enabledState") : t("disabledState")}</td>
                    <td className={tdCls}>
                      <div className="flex flex-wrap items-center gap-2">
                        <form action={moveRoutingRuleAction}>
                          <input type="hidden" name="ruleId" value={r.id} />
                          <input type="hidden" name="direction" value="up" />
                          <button
                            type="submit"
                            className={ghostButtonCls}
                            disabled={i === 0}
                            aria-label={t("moveUp", { name: r.name })}
                          >
                            ↑
                          </button>
                        </form>
                        <form action={moveRoutingRuleAction}>
                          <input type="hidden" name="ruleId" value={r.id} />
                          <input type="hidden" name="direction" value="down" />
                          <button
                            type="submit"
                            className={ghostButtonCls}
                            disabled={i === rules.length - 1}
                            aria-label={t("moveDown", { name: r.name })}
                          >
                            ↓
                          </button>
                        </form>
                        <ConfirmButton
                          action={deleteRoutingRuleAction.bind(null, r.id)}
                          label={t("delete")}
                          confirmLabel={t("deleteConfirm")}
                          cancelLabel={t("cancel")}
                          prompt={t("deletePrompt", { name: r.name })}
                        />
                      </div>
                      <details className="mt-2">
                        <summary className="cursor-pointer text-accent">{t("edit")}</summary>
                        <div className="mt-3">
                          <RuleForm
                            values={valuesOf(r)}
                            connections={connectionOptions}
                            stores={storeOptions}
                          />
                        </div>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("add")}</h2>
        {connectionOptions.length === 0 ? (
          <p className="m-0 text-muted">
            {t("noConnections")}{" "}
            <Link href="/warehouses" className="text-accent hover:underline">
              {t("toWarehouses")}
            </Link>
          </p>
        ) : (
          <RuleForm values={EMPTY_RULE} connections={connectionOptions} stores={storeOptions} />
        )}
      </Card>

      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("tryTitle")}</h2>
        <p className="mt-0 text-sm text-muted">{t("tryHelp")}</p>
        <form
          method="get"
          className="flex flex-wrap items-end gap-3"
          role="search"
          aria-label={t("tryTitle")}
        >
          <label className="flex flex-col gap-1 text-[13px] font-medium">
            {t("orderNumber")}
            <input
              name="order"
              defaultValue={number ?? ""}
              className={`${inputCls} font-mono`}
              placeholder="#1001"
            />
          </label>
          <button type="submit" className={ghostButtonCls}>
            {t("tryButton")}
          </button>
        </form>
        {tried && tried.length === 0 && <p className="text-muted">{t("tryNotFound")}</p>}
        {tried?.map((o) => (
          <section key={o.id} className="mt-4 rounded-[10px] border border-line p-4" aria-label={o.number}>
            <p className="m-0 font-mono text-sm text-muted">{o.number}</p>
            <p className="my-2 font-medium" data-testid="routing-explanation">
              {o.decision.explanation[lang]}
            </p>
            <ol className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
              {o.decision.steps.map((s) => (
                <li key={s.ruleId}>
                  <span className="font-mono">{s.number}.</span> {s.name} — {t(`outcome.${s.outcome}`)}
                  {s.failed ? ` (${t(`condition.${s.failed}`)})` : ""}
                </li>
              ))}
            </ol>
            {o.decision.stock && (
              <ul className="mt-2 mb-0 text-sm text-muted">
                {o.decision.stock.lines.map((l, k) => (
                  <li key={k}>
                    <span className="font-mono">{l.title}</span>:{" "}
                    {t("stockLine", { need: l.need, available: l.available ?? "—" })}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </Card>
    </>
  );
}
