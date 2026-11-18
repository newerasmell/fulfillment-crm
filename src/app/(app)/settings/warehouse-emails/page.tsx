import { getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { DEFAULT_CUSTOMER_BODY, DEFAULT_CUSTOMER_SUBJECT } from "@/lib/warehouse-case-emails";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { listCompanies } from "@/server/companies";
import { defaultsFor, escalationSettingsByCompany } from "@/server/warehouse-cases/settings";
import { EscalationForm } from "./form";

/** Per company: the warehouse addresses of „Блокирани в склад“, its own Gmail, when each email is due, the customer email. */
export default async function WarehouseEmailsPage() {
  const ctx = await requireAccountContext();
  const t = await getTranslations("warehouseEmails");
  const actor = actorFrom(ctx);
  const [companies, settings] = await Promise.all([
    listCompanies(actor),
    escalationSettingsByCompany(ctx.accountId),
  ]);
  const canEdit = can(ctx.role, "companies.manage");
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("intro")} />
      {companies.map((co) => {
        const s = settings.get(co.id) ?? defaultsFor(co.id);
        return (
          <Card key={co.id}>
            <h2 className="m-0 mb-3 text-lg font-bold">{co.name}</h2>
            <EscalationForm
              canEdit={canEdit}
              defaults={{ subject: DEFAULT_CUSTOMER_SUBJECT, body: DEFAULT_CUSTOMER_BODY }}
              s={{
                companyId: co.id,
                senderEmail: s.senderEmail ?? "",
                warehouseTo: s.warehouseTo.join(", "),
                warehouseCc: s.warehouseCc.join(", "),
                escalationTo: s.escalationTo.join(", "),
                flagHours: s.flagHours,
                firstEmailHours: s.firstEmailHours,
                reminderHours: s.reminderHours,
                decisionHours: s.decisionHours,
                workDaysOnly: s.workDaysOnly,
                discountPercent: s.discountPercent === null ? "" : String(s.discountPercent),
                customerSubject: s.customerSubject ?? "",
                customerBody: s.customerBody ?? "",
              }}
            />
          </Card>
        );
      })}
    </>
  );
}
