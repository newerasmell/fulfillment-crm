import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isScope, SCOPE_COOKIE, SCOPE_TYPES } from "@/components/shell/scope";
import { writeCsv } from "@/lib/xlsx";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, getAccountContext } from "@/server/auth/session";
import { COD_TABS, exportCodCsv, type CodTab } from "@/server/cod/board";
import { COD_BUCKETS, type CodBucket } from "@/server/cod/classify";

/** CSV of the COD board with the same filters as the screen (tab, bucket, search, company/line, warehouse). */
export async function GET(req: Request) {
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const tab = (COD_TABS as readonly string[]).includes(sp.get("tab") ?? "")
    ? (sp.get("tab") as CodTab)
    : "all";
  const b = sp.get("bucket") ?? "";
  const bucket = (COD_BUCKETS as readonly string[]).includes(b) ? (b as CodBucket) : undefined;
  const rawScope = (await cookies()).get(SCOPE_COOKIE)?.value;
  const scope = isScope(rawScope) ? rawScope : "all";
  try {
    const rows = await exportCodCsv(
      { ...actorFrom(ctx), activeCompanyId: ctx.activeCompanyId, lineCompanyIds: ctx.lineCompanyIds },
      {
        tab,
        bucket,
        q: sp.get("q")?.slice(0, 80) || undefined,
        connectionTypes: scope === "all" ? undefined : SCOPE_TYPES[scope],
      },
    );
    const date = new Date().toISOString().slice(0, 10);
    return new NextResponse(new Uint8Array(Buffer.from(writeCsv(rows), "utf8")), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="cod-${tab}-${date}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    throw err;
  }
}
