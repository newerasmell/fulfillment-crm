import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { accountDb } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";

/**
 * Label PDFs live in the database (ShipmentLabel.content): the codebase has no object store, and a vendor may
 * refuse a reprint later (Joy: 5 days). Fulfillment.labelFileKey points at the latest single label.
 */

export const MAX_LABEL_BYTES = 8 * 1024 * 1024;

export function decodeLabel(base64: string, format: "PDF" | "ZPL" = "PDF"): Buffer {
  const bytes = format === "PDF" ? Buffer.from(base64, "base64") : Buffer.from(base64, "utf8");
  if (bytes.length === 0) throw new Error("empty label");
  if (bytes.length > MAX_LABEL_BYTES) throw new Error("label too large");
  if (format === "PDF" && bytes.subarray(0, 5).toString("latin1") !== "%PDF-")
    throw new Error("label is not a PDF");
  return bytes;
}

export async function storeLabel(
  tx: Prisma.TransactionClient,
  input: {
    accountId: string;
    connectionId: string;
    fulfillmentId?: string | null;
    source: string;
    base64: string;
    format?: "PDF" | "ZPL";
    kind?: "single" | "bulk";
    fulfillmentIds?: string[];
    createdById?: string | null;
  },
) {
  const bytes = decodeLabel(input.base64, input.format ?? "PDF");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const label = await tx.shipmentLabel.create({
    data: {
      accountId: input.accountId,
      connectionId: input.connectionId,
      fulfillmentId: input.fulfillmentId ?? null,
      kind: input.kind ?? "single",
      format: input.format ?? "PDF",
      source: input.source,
      content: new Uint8Array(bytes),
      sha256,
      sizeBytes: bytes.length,
      fulfillmentIds: input.fulfillmentIds ?? (input.fulfillmentId ? [input.fulfillmentId] : []),
      createdById: input.createdById ?? null,
    },
    select: { id: true },
  });
  if (input.fulfillmentId && (input.kind ?? "single") === "single")
    await tx.fulfillment.update({ where: { id: input.fulfillmentId }, data: { labelFileKey: label.id } });
  return label;
}

/**
 * A stored label for download (no vendor call). Company scope: a single label follows its order's company,
 * a bulk PDF needs every covered shipment in scope.
 */
export async function labelForDownload(actor: ScopedActor, labelId: string) {
  const db = accountDb(actor.accountId);
  const label = await db.shipmentLabel.findUnique({ where: { id: labelId } });
  if (!label) throw new DomainError("not_found");
  if (actor.companyScope) {
    const ids = label.fulfillmentIds.length
      ? label.fulfillmentIds
      : label.fulfillmentId
        ? [label.fulfillmentId]
        : [];
    const rows = await db.fulfillment.findMany({
      where: { id: { in: ids } },
      select: { order: { select: { companyId: true } } },
    });
    if (
      ids.length === 0 ||
      rows.length !== ids.length ||
      rows.some((r) => !actor.companyScope!.includes(r.order.companyId ?? ""))
    )
      throw new DomainError("not_found");
  }
  return label;
}
