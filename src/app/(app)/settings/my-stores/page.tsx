import { getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { requireAccountContext } from "@/server/auth/session";
import { myStoreIds, storesByLine } from "@/server/store-preferences";
import { MyStoresForm } from "./form";

/** „Моите магазини“ (owner request 2026-11-24): the stores this member works with; the orders list starts with them. */
export default async function MyStoresPage() {
  const ctx = await requireAccountContext();
  const t = await getTranslations("myStores");
  const [groups, mine] = await Promise.all([
    storesByLine({ accountId: ctx.accountId, companyScope: ctx.companyScope, activeCompanyId: null }),
    myStoreIds({ accountId: ctx.accountId, userId: ctx.user.id, companyScope: ctx.companyScope }),
  ]);
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("intro")} />
      <Card>
        <MyStoresForm groups={groups} selected={mine} />
      </Card>
    </>
  );
}
