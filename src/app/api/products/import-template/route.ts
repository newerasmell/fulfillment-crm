import { NextResponse } from "next/server";
import { writeXlsx } from "@/lib/xlsx";
import { can } from "@/server/auth/rbac";
import { getAccountContext } from "@/server/auth/session";
import { importTemplate } from "@/server/products/import";

/** The Excel template of „Импорт от Excel“ for one warehouse type: exactly the columns that warehouse needs. */
export async function GET(req: Request) {
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(ctx.role, "vendorProducts.write"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const type = new URL(req.url).searchParams.get("type") === "EUSHIPMENTS" ? "EUSHIPMENTS" : "FHB_V3";
  const name = type === "EUSHIPMENTS" ? "products-eushipments" : "products-fhb";
  return new NextResponse(new Uint8Array(writeXlsx(importTemplate(type), "Products")), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${name}.xlsx"`,
      "cache-control": "no-store",
    },
  });
}
