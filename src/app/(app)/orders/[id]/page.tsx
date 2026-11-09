import { requireAccountContext } from "@/server/auth/session";
import { orderDesignOf } from "@/server/preferences";
import { ClassicOrderView } from "./_classic/view";
import { NewOrderView } from "./new-view";

/**
 * Order detail. Two designs side by side (owner request 2026-11-06): "Нов" (redesign) and "Класически" (the page as
 * it was), chosen per person with the toggle in the header and saved for them (UserPreference).
 */
export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAccountContext();
  const design = await orderDesignOf(ctx.user.id);
  return design === "classic" ? (
    <ClassicOrderView params={params} searchParams={searchParams} />
  ) : (
    <NewOrderView params={params} searchParams={searchParams} />
  );
}
