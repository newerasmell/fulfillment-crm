import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { buttonCls, inputCls, tdCls, thCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { listManualShipments, LIST_TABS, type ListTab } from "@/server/labels";
import { listCompanies } from "@/server/companies";
import { joyConnectionsForSettings } from "@/server/labels/views";
import { StatusChip } from "../orders/status";
import { BulkLabelBar, LabelCheckbox, LabelSelection, SelectAllLabels } from "./bulk";
import { JoyConnectionCard, NewJoyConnectionForm } from "./joy-forms";
import { KindChip } from "./chips";

/** Ръчни пратки и етикети (SPEC §6.6, DESIGN.md "Склад"): manual shipments, labels, bulk label PDF. */

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function ManualShipmentsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const ctx = await requireAccountContext();
  const actor = actorFrom(ctx);
  const t = await getTranslations("manual");
  const tm = await getTranslations("mode");
  const format = await getFormatter();
  const tabParam = one(sp.tab);
  const tab: ListTab = (LIST_TABS as readonly string[]).includes(tabParam ?? "")
    ? (tabParam as ListTab)
    : "all";
  const q = one(sp.q)?.slice(0, 60);
  const { rows, counts } = await listManualShipments(actor, { tab, q });
  const printable = rows
    .filter(
      (r) => r.fulfillment && (r.kind === "JOY_LABEL" || (r.kind === "AWB" && r.fulfillment.vendorOrderId)),
    )
    .map((r) => r.fulfillment!.id);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const tabCount: Record<ListTab, number | null> = {
    all: total,
    labels: (counts.JOY_LABEL ?? 0) + (counts.AWB ?? 0) + (counts.PRE_AWB ?? 0),
    warehouse: counts.WAREHOUSE ?? 0,
    attention: null,
  };
  const manageJoy = can(ctx.role, "connections.manage");
  const [joyConnections, companies] = manageJoy
    ? await Promise.all([joyConnectionsForSettings(actor), listCompanies(actorFrom(ctx))])
    : [[], []];

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          can(ctx.role, "orders.fulfill") ? (
            <Link href="/manual-shipments/new" className={`${buttonCls} flex items-center no-underline`}>
              {t("new")}
            </Link>
          ) : null
        }
      />
      <nav aria-label={t("tabsLabel")} className="flex flex-wrap gap-1 border-b border-line">
        {LIST_TABS.map((k) => (
          <Link
            key={k}
            href={`/manual-shipments?tab=${k}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
            aria-current={k === tab ? "page" : undefined}
            className={`-mb-px flex min-h-11 items-center gap-2 border-b-2 px-3 no-underline ${
              k === tab
                ? "border-accent font-semibold text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {t(`tabs.${k}`)}
            {tabCount[k] !== null && (
              <span className="rounded-full bg-hover px-2 py-0.5 font-mono text-xs">{tabCount[k]}</span>
            )}
          </Link>
        ))}
      </nav>
      <LabelSelection ids={printable}>
        <Card>
          <form className="mb-4 flex flex-wrap items-end gap-3" role="search">
            <input type="hidden" name="tab" value={tab} />
            <input
              name="q"
              defaultValue={q}
              placeholder={t("search")}
              aria-label={t("search")}
              className={`${inputCls} w-72`}
            />
          </form>
          {rows.length === 0 ? (
            <p className="m-0 text-muted">{t("empty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th className={thCls}>
                      <SelectAllLabels />
                    </th>
                    <th className={thCls}>{t("col.number")}</th>
                    <th className={thCls}>{t("col.kind")}</th>
                    <th className={thCls}>{t("col.recipient")}</th>
                    <th className={thCls}>{t("col.connection")}</th>
                    <th className={thCls}>{t("col.status")}</th>
                    <th className={thCls}>{t("col.tracking")}</th>
                    <th className={thCls}>{t("col.label")}</th>
                    <th className={thCls}>{t("col.created")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const f = r.fulfillment;
                    const canPrint = !!f && printable.includes(f.id);
                    return (
                      <tr key={r.id} className="hover:bg-hover">
                        <td className={tdCls}>
                          {canPrint && <LabelCheckbox id={f!.id} number={r.order.number} />}
                        </td>
                        <td className={tdCls}>
                          <Link href={`/manual-shipments/${r.id}`} className="font-mono font-semibold">
                            {r.order.number}
                          </Link>
                          {f && <div className="font-mono text-xs text-muted">{f.externalId}</div>}
                        </td>
                        <td className={tdCls}>
                          <KindChip kind={r.kind} label={t(`kind.${r.kind}`)} />
                        </td>
                        <td className={tdCls}>
                          {r.order.customerName}
                          <span className="ml-1 font-mono text-xs text-muted">{r.order.countryCode}</span>
                        </td>
                        <td className={tdCls}>
                          {r.connection.name}
                          <div className="text-xs text-muted">{tm(r.connection.liveMode)}</div>
                        </td>
                        <td className={tdCls}>
                          <StatusChip status={f?.status ?? r.order.status} />
                          {f?.rawStatus && <div className="text-xs text-muted">{f.rawStatus}</div>}
                        </td>
                        <td className={`${tdCls} font-mono text-xs`}>
                          {f?.trackingNumbers.join(", ") || "—"}
                        </td>
                        <td className={tdCls}>
                          {f?.labelFileKey ? (
                            <a href={`/api/labels/${f.labelFileKey}`} target="_blank" rel="noopener">
                              {t("label.download")}
                            </a>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className={`${tdCls} whitespace-nowrap text-muted`}>
                          {format.dateTime(r.createdAt, { dateStyle: "short", timeStyle: "short" })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <BulkLabelBar />
      </LabelSelection>
      {manageJoy && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("joy.title")}</h2>
          <p className="mt-0 text-sm text-muted">{t("joy.body")}</p>
          <div className="flex flex-col gap-4">
            {joyConnections.map((c) => (
              <JoyConnectionCard
                key={c.id}
                connection={{
                  id: c.id,
                  name: c.name,
                  liveMode: c.liveMode,
                  company: c.company?.name ?? "",
                  parcelServices: c.settings.parcelServices,
                  pickupServices: c.settings.pickupServices,
                  sender: c.settings.sender ?? "",
                  senderName: c.settings.senderName ?? "",
                  lastTest: c.settings.lastTest ?? null,
                }}
                canRaise={can(ctx.role, "connections.raiseMode")}
              />
            ))}
            <details className="rounded-xl border border-line p-4">
              <summary className="cursor-pointer font-semibold">{t("joy.add")}</summary>
              <div className="mt-3">
                <NewJoyConnectionForm
                  companies={companies.filter((c) => !c.archivedAt).map((c) => ({ id: c.id, name: c.name }))}
                />
              </div>
            </details>
          </div>
        </Card>
      )}
    </>
  );
}
