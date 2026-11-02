import { NextResponse } from "next/server";
import { writeCsv, writeXlsx } from "@/lib/xlsx";
import { DomainError } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, getAccountContext } from "@/server/auth/session";
import { exportMapping } from "@/server/lines/mapping";

/** Excel/CSV export of a line's product mapping (P5-00). Same scope rules as the screen. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const format = new URL(req.url).searchParams.get("format") === "csv" ? "csv" : "xlsx";
  try {
    const { name, rows } = await exportMapping(actorFrom(ctx), id);
    const date = new Date().toISOString().slice(0, 10);
    const base = `mapping-${name.replace(/[^\p{L}\p{N}-]+/gu, "_")}-${date}`;
    const body = format === "csv" ? Buffer.from(writeCsv(rows), "utf8") : writeXlsx(rows, name);
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "content-type":
          format === "csv"
            ? "text/csv; charset=utf-8"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="mapping-${date}.${format}"; filename*=UTF-8''${encodeURIComponent(`${base}.${format}`)}`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (err instanceof DomainError) return NextResponse.json({ error: err.code }, { status: 404 });
    throw err;
  }
}
