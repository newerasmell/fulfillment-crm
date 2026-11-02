import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls } from "@/components/ui/form";
import { DomainError } from "@/server/accounts";
import { can, ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { getFulfillBatch } from "@/server/fulfill";
import { FulfillProgress } from "./progress";

export default async function FulfillBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAccountContext();
  const t = await getTranslations("fulfill");
  let view;
  try {
    view = await getFulfillBatch(actorFrom(ctx), id);
  } catch (err) {
    if (err instanceof DomainError || err instanceof ForbiddenError) notFound();
    throw err;
  }
  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Link href="/orders" className={ghostButtonCls + " inline-flex items-center"}>
            {t("back")}
          </Link>
        }
      />
      <FulfillProgress
        initial={JSON.parse(JSON.stringify(view))}
        canConfirm={can(ctx.role, "outbox.confirmCanary")}
      />
    </>
  );
}
