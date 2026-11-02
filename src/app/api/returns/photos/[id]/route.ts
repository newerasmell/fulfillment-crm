import { NextResponse } from "next/server";
import { DomainError } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, getAccountContext } from "@/server/auth/session";
import { readReturnPhoto } from "@/server/returns";

/** A FHB local return photo the worker stored (P6-01). Same scope rules as the returns board; never a vendor call. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAccountContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const photo = await readReturnPhoto(actorFrom(ctx), id);
    return new NextResponse(new Uint8Array(photo.bytes), {
      headers: {
        "content-type": photo.contentType,
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, max-age=3600",
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (err instanceof DomainError) return NextResponse.json({ error: err.code }, { status: 404 });
    throw err;
  }
}
