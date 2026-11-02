import { NextResponse } from "next/server";
import { DomainError } from "@/server/accounts";
import { actorFrom, getAccountContext } from "@/server/auth/session";
import { labelForDownload } from "@/server/labels";

/** Download of a stored label PDF (P7-01). Reads the CRM database only — never calls a vendor. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!/^[a-z0-9]{1,64}$/i.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const label = await labelForDownload(actorFrom(ctx), id);
    const ext = label.format === "ZPL" ? "zpl" : "pdf";
    return new NextResponse(new Uint8Array(label.content), {
      headers: {
        "content-type": label.format === "ZPL" ? "text/plain; charset=utf-8" : "application/pdf",
        "content-disposition": `inline; filename="label-${label.id}.${ext}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof DomainError) return NextResponse.json({ error: "not_found" }, { status: 404 });
    throw err;
  }
}
