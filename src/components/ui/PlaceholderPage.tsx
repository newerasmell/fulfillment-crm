import { getTranslations } from "next-intl/server";
import { requireAccountContext } from "@/server/auth/session";
import { Card, PageHeader } from "./PageHeader";

/** Empty screen for a menu entry that is built in a later phase (BACKLOG P0-11). */
export async function PlaceholderPage({ titleKey, phase }: { titleKey: string; phase: number }) {
  await requireAccountContext();
  const t = await getTranslations("pages");
  return (
    <>
      <PageHeader title={t(titleKey)} />
      <Card>
        <p className="m-0 text-muted">{t("placeholder", { phase })}</p>
      </Card>
    </>
  );
}
