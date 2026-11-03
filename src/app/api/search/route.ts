import { NextResponse } from "next/server";
import { z } from "zod";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, getAccountContext } from "@/server/auth/session";
import { globalSearch } from "@/server/shipments";

export const dynamic = "force-dynamic";

const Q = z.string().trim().min(2).max(80);

/** Header search (Ctrl/Cmd K): orders and shipments (tracking number) in the member's scope. */
export async function GET(req: Request) {
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = Q.safeParse(new URL(req.url).searchParams.get("q") ?? "");
  if (!q.success) return NextResponse.json({ orders: [], shipments: [] });
  try {
    const r = await globalSearch(
      { ...actorFrom(ctx), activeCompanyId: ctx.activeCompanyId, lineCompanyIds: ctx.lineCompanyIds },
      q.data,
    );
    return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof ForbiddenError) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    throw err;
  }
}
