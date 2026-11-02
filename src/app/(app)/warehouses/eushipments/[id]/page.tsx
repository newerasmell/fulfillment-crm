import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { runEuSyncAction } from "@/app/actions/eushipments";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, tdCls, thCls } from "@/components/ui/form";
import { DomainError } from "@/server/accounts";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { getEuConnection } from "@/server/eushipments/connections";
import { prefixOf } from "@/server/eushipments/read";
import { MANUAL_SYNCS } from "@/server/eushipments/jobs";
import { MIRROR_TABS, type MirrorTab } from "@/server/eushipments/mirror";
import { EuModeStepper, EuSettingsForm, EuTokenForm } from "../forms";
import { Freshness, TabLabel, TestBadge, WarehouseChip } from "../ui";
import { MirrorTabContent } from "./tabs";

type Search = { tab?: string; q?: string; filter?: string; page?: string };

export default async function EuShipmentsConnectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await requireAccountContext();
  const t = await getTranslations();
  let c;
  try {
    c = await getEuConnection(actorFrom(ctx), id);
  } catch (err) {
    if (err instanceof DomainError) notFound();
    throw err;
  }
  const tab: MirrorTab = (MIRROR_TABS as readonly string[]).includes(sp.tab ?? "")
    ? (sp.tab as MirrorTab)
    : "products";
  const sync = (k: string) => c.eushipmentsSyncs.find((s) => s.kind === k) ?? null;
  const vc = c.eushipmentsVendorCompanies.find((v) => v.vendorCompanyId === c.vendorCompanyId);
  const manage = can(ctx.role, "connections.manage");
  const canSync = can(ctx.role, "eushipments.sync");
  const hrefFor = (next: MirrorTab) => `/warehouses/eushipments/${id}?tab=${next}`;

  return (
    <>
      <PageHeader
        title={c.name}
        subtitle={t("eushipments.detailIntro")}
        actions={
          <Link href="/warehouses/eushipments" className="text-accent hover:underline">
            ← {t("eushipments.title")}
          </Link>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <WarehouseChip />
          <span>{c.company?.name ?? "—"}</span>
          <span className="font-mono text-[13px] text-muted">
            {t("eushipments.vendorCompany")}:{" "}
            {c.vendorCompanyId ? `${vc?.name ?? ""} ${c.vendorCompanyId}`.trim() : "—"}
          </span>
          <TestBadge sync={sync("connection")} />
          {!c.enabled && (
            <span className="rounded-full bg-block-bg px-2 py-0.5 text-xs text-block">
              {t("eushipments.disabled")}
            </span>
          )}
        </div>
        <h2 className="mb-2 mt-4 text-base font-semibold">{t("eushipments.mode")}</h2>
        <EuModeStepper
          id={c.id}
          current={c.liveMode}
          canRaise={can(ctx.role, "connections.raiseMode")}
          canLower={manage}
        />
        <p className="mb-0 mt-2 text-sm text-muted">{t(`eushipments.modeHelp.${c.liveMode}`)}</p>
      </Card>

      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("eushipments.freshness")}</h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thCls}>{t("eushipments.syncKind")}</th>
                <th className={thCls}>{t("eushipments.lastOk")}</th>
                <th className={thCls}>{t("eushipments.lastError")}</th>
                {canSync && <th className={thCls} />}
              </tr>
            </thead>
            <tbody>
              {MANUAL_SYNCS.map((k) => {
                const s = sync(k === "test" ? "connection" : k);
                return (
                  <tr key={k}>
                    <td className={tdCls}>{t(`eushipments.syncs.${k}`)}</td>
                    <td className={tdCls}>
                      <Freshness at={s?.lastOkAt ?? null} />
                    </td>
                    <td className={`${tdCls} text-sm text-block`}>
                      {s?.lastError
                        ? t.has(`eushipments.errors.${s.lastError}`)
                          ? t(`eushipments.errors.${s.lastError}`)
                          : s.lastError
                        : ""}
                    </td>
                    {canSync && (
                      <td className={tdCls}>
                        <form action={runEuSyncAction.bind(null, c.id, k)}>
                          <button type="submit" className={ghostButtonCls}>
                            {t("eushipments.run")}
                          </button>
                        </form>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <section aria-label={t("eushipments.mirror")} className="flex flex-col gap-4">
        <nav aria-label={t("eushipments.mirror")} className="flex flex-wrap gap-1 border-b border-line">
          {MIRROR_TABS.map((m) => (
            <Link
              key={m}
              href={hrefFor(m)}
              aria-current={m === tab ? "page" : undefined}
              className={`min-h-11 rounded-t-[10px] px-3 py-2 text-sm font-semibold ${
                m === tab ? "bg-accent-soft text-accent-strong" : "text-ink hover:bg-hover"
              }`}
            >
              <TabLabel bg={t(`eushipments.tabs.${m}`)} original={t(`eushipments.tabsOriginal.${m}`)} />
            </Link>
          ))}
        </nav>
        <MirrorTabContent
          tab={tab}
          accountId={ctx.accountId}
          connectionId={c.id}
          prefix={prefixOf(c.skuPrefixRule)}
          canLink={can(ctx.role, "products.match")}
          canSync={canSync}
          search={sp}
        />
      </section>

      {manage && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("eushipments.settings")}</h2>
          <EuSettingsForm
            id={c.id}
            companies={ctx.companies}
            vendorCompanies={c.eushipmentsVendorCompanies.map((v) => ({
              vendorCompanyId: v.vendorCompanyId,
              name: v.name,
            }))}
            s={{
              name: c.name,
              companyId: c.companyId,
              vendorCompanyId: c.vendorCompanyId,
              skuPrefix: prefixOf(c.skuPrefixRule),
              acceptedAlertHours: c.eushipmentsSettings?.acceptedAlertHours ?? 24,
              acceptedAlertWorkDays: c.eushipmentsSettings?.acceptedAlertWorkDays ?? true,
              cashReceiptCod: c.eushipmentsSettings?.cashReceiptCod ?? false,
              canaryDailyCap: c.canaryDailyCap,
              enabled: c.enabled,
            }}
          />
          <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
            <p className="m-0 text-sm">
              {t("eushipments.tokenStored")}{" "}
              <span className="font-mono text-muted">{c.credential?.hint ?? "—"}</span>
            </p>
            <EuTokenForm id={c.id} />
          </div>
          {c.eushipmentsVendorCompanies.length > 1 && (
            <div className="mt-4 border-t border-line pt-4">
              <h3 className="mt-0 text-sm font-semibold">{t("eushipments.tokenCompanies")}</h3>
              <p className="mt-0 text-sm text-muted">{t("eushipments.tokenCompaniesHelp")}</p>
              <ul className="m-0 list-none p-0 font-mono text-[13px]">
                {c.eushipmentsVendorCompanies.map((v) => (
                  <li key={v.vendorCompanyId}>
                    {v.name} · {v.vendorCompanyId}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
