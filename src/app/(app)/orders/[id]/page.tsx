import { requireAccountContext } from "@/server/auth/session";
import { orderDesignOf } from "@/server/preferences";
import { ClassicOrderView } from "./_classic/view";
import { NewOrderView } from "./new-view";

/**
 * Order detail. Two designs side by side (owner request 2026-11-06): "Нов" (redesign) and "Класически" (the page as
 * it was), chosen per person with the toggle in the header and saved for them (UserPreference).
 */
export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAccountContext();
  const design = await orderDesignOf(ctx.user.id);
  return design === "classic" ? <ClassicOrderView params={params} /> : <NewOrderView params={params} />;
}
