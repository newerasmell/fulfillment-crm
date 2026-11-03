import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isScope, SCOPE_COOKIE, SCOPE_TYPES } from "@/components/shell/scope";
import { writeCsv } from "@/lib/xlsx";
import { can, ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, getAccountContext } from "@/server/auth/session";
import { exportShipmentsCsv, parseShipmentFilter } from "@/server/shipments";

/** CSV of Товарителници with the same filters as the screen (CSV-injection safe: writeCsv guards formulas). */
export async function GET(req: Request) {
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const f = parseShipmentFilter(Object.fromEntries(sp.entries()));
  const rawScope = (await cookies()).get(SCOPE_COOKIE)?.value;
  const scope = isScope(rawScope) ? rawScope : "all";
  try {
    const rows = await exportShipmentsCsv(
      { ...actorFrom(ctx), activeCompanyId: ctx.activeCompanyId, lineCompanyIds: ctx.lineCompanyIds },
      { ...f, page: undefined, connectionTypes: scope === "all" ? undefined : SCOPE_TYPES[scope] },
      { withCod: can(ctx.role, "cod.read") },
    );
    const date = new Date().toISOString().slice(0, 10);
    return new NextResponse(new Uint8Array(Buffer.from(writeCsv(rows), "utf8")), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="shipments-${f.view ?? "all"}-${date}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    throw err;
  }
}
