import { getTranslations } from "next-intl/server";
import { CountryCurrencyForm } from "@/components/rules-weights/CountryCurrencyForm";
import { PhoneRuleForm } from "@/components/rules-weights/PhoneRuleForm";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, inputCls, tdCls, thCls } from "@/components/ui/form";
import type { PhoneRule } from "@/integrations/eushipments/phone";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { listCountries, suggestPhoneRule } from "@/server/countries/phone-rules";

/**
 * Настройки → Държави: local currency and phone rule per destination country. The euShipments guideline rules
 * (INTEGRATION_NOTES §4.4) are shown read-only; our own rules fill the other countries (OWNER/ADMIN, audited).
 */

function RuleText({ rule, t }: { rule: PhoneRule; t: (k: string) => string }) {
  return (
    <span className="font-mono text-[13px]">
      {rule.style === "international" ? `+${rule.cc}` : t("styleNational")}
      {rule.trunk ? ` · trunk ${rule.trunk}` : ""} · {rule.lengths.join("/")}
    </span>
  );
}

export default async function CountriesPage({ searchParams }: { searchParams: Promise<{ add?: string }> }) {
  const ctx = await requireAccountContext();
  const t = await getTranslations("countries");
  const rows = await listCountries(actorFrom(ctx));
  const manage = can(ctx.role, "countries.manage");
  const add = ((await searchParams).add ?? "").trim().toUpperCase();
  const adding = /^[A-Z]{2}$/.test(add) && !rows.some((r) => r.country === add) ? add : null;
  const tt = (k: string) => t(k);
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("intro")} />
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse" aria-label={t("title")}>
            <thead>
              <tr>
                <th className={thCls}>{t("country")}</th>
                <th className={thCls}>{t("currency")}</th>
                <th className={thCls}>{t("phoneRule")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.country} data-testid={`country-${r.country}`}>
                  <td className={`${tdCls} font-mono`}>{r.country}</td>
                  <td className={tdCls}>
                    {manage ? (
                      <CountryCurrencyForm country={r.country} currency={r.currency} />
                    ) : (
                      <span className="font-mono">{r.currency ?? "—"}</span>
                    )}
                    {r.currencyDefault && r.currency && (
                      <div className="text-xs text-muted">{t("currencyDefault")}</div>
                    )}
                    {!r.currency && <div className="text-xs text-warn">{t("currencyMissing")}</div>}
                  </td>
                  <td className={tdCls}>
                    {r.builtin ? (
                      <div className="flex flex-col gap-1">
                        <RuleText rule={r.builtin} t={tt} />
                        <span className="text-xs text-muted">{t("builtin")}</span>
                        {r.customIgnored && <span className="text-xs text-warn">{t("customIgnored")}</span>}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {r.custom ? (
                          <>
                            <RuleText rule={r.custom} t={tt} />
                            <span className="text-xs text-muted">{t("custom")}</span>
                          </>
                        ) : (
                          <span className="text-sm text-warn">{t("none")}</span>
                        )}
                        {manage && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-sm text-accent">{t("edit")}</summary>
                            <div className="mt-2">
                              <PhoneRuleForm
                                country={r.country}
                                initial={
                                  r.custom ??
                                  suggestPhoneRule(null, r.country) ?? {
                                    style: "international",
                                    cc: "",
                                    trunk: "",
                                    lengths: [8],
                                  }
                                }
                                samplePhone={null}
                                needsCurrency={!r.currency}
                                defaultCurrency={r.currency}
                                canRemove={!!r.custom}
                              />
                            </div>
                          </details>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {manage && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("addCountry")}</h2>
          {adding ? (
            <PhoneRuleForm
              country={adding}
              initial={
                suggestPhoneRule(null, adding) ?? { style: "international", cc: "", trunk: "", lengths: [8] }
              }
              samplePhone={null}
              needsCurrency
              defaultCurrency={null}
              canRemove={false}
            />
          ) : (
            <form method="get" className="flex flex-wrap items-center gap-2">
              <input
                name="add"
                required
                maxLength={2}
                placeholder="CY"
                aria-label={t("country")}
                className={`${inputCls} w-24 font-mono uppercase`}
              />
              <button type="submit" className={ghostButtonCls}>
                {t("addCountry")}
              </button>
            </form>
          )}
        </Card>
      )}
    </>
  );
}
