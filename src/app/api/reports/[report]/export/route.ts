import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { writeCsv } from "@/lib/xlsx";
import { ForbiddenError } from "@/server/auth/rbac";
import { getAccountContext } from "@/server/auth/session";
import {
  codCsv,
  codReport,
  isReportKey,
  ordersCsv,
  ordersReport,
  parseRange,
  reviewCsv,
  reviewReport,
  shipmentsCsv,
  shipmentsReport,
  stockCsv,
  stockReport,
  timingCsv,
  timingReport,
} from "@/server/reports";
import { reportCtxOf } from "@/app/(app)/reports/context";

/**
 * CSV of one report with the same period and scope as the screen (company / line from the sidebar, warehouse
 * scope from the header). writeCsv neutralises spreadsheet formulas (CSV injection).
 */
export async function GET(req: Request, { params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  if (!isReportKey(report)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const range = parseRange({
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    preset: sp.get("preset") ?? undefined,
  });
  const { rc } = await reportCtxOf(ctx);
  const t = await getTranslations("reports");
  try {
    let rows: string[][];
    switch (report) {
      case "orders":
        rows = ordersCsv(await ordersReport(rc, range), {
          manual: t("orders.manual"),
          noCompany: t("orders.noCompany"),
        });
        break;
      case "shipments":
        rows = shipmentsCsv(await shipmentsReport(rc, range), { noCarrier: t("shipments.noCarrier") });
        break;
      case "timing":
        rows = timingCsv(await timingReport(rc, range), {
          all: t("timing.all"),
          noShipment: t("timing.noShipment"),
        });
        break;
      case "cod":
        rows = codCsv(await codReport(rc, range));
        break;
      case "review":
        rows = reviewCsv(await reviewReport(rc, range));
        break;
      case "stock":
        rows = stockCsv(await stockReport(rc));
        break;
    }
    const name =
      report === "stock" ? `report-stock-${range.to}` : `report-${report}-${range.from}_${range.to}`;
    return new NextResponse(new Uint8Array(Buffer.from(writeCsv(rows), "utf8")), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${name}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    throw err;
  }
}
