import { Shell } from "@/components/shell/Shell";
import { requireAccountContext } from "@/server/auth/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireAccountContext();
  return <Shell ctx={ctx}>{children}</Shell>;
}
