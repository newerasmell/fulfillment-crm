import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { payloadHash } from "@/integrations/fhb-v3/adapter";
import { buildFhbProductCreate, buildFhbProductUpdate, fhbProductId } from "@/integrations/fhb-v3/mapper";
import { hasHardBlock, validateFhbProduct } from "@/integrations/fhb-v3/validators";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { withAccountTransaction } from "@/server/db/client";
import { enqueueOutboundInTx } from "@/server/outbox/outbox";
import { fhbStockNotifyUrl, publicBaseUrl } from "./callback-token";
import { assertConnectionInScope, type ScopedActor } from "./connection";
import { FhbPreflightError } from "./orders";

/**
 * Products at FHB (INTEGRATION_NOTES §2.1, §2.2), behind the outbox:
 *  - not yet at FHB → POST /product with id = connection prefix + CRM SKU, the first known EAN, the signed stock
 *    `notify_url`, photo and customs data;
 *  - already at FHB → PUT /product with name/photo/notify_url/customs and NO `ean` — FHB may have corrected it to
 *    the real EAN on the box. Only a person typing an EAN in the CRM (`explicitEan`) sends one;
 *  - bundles → `type: "multi"` with components that must exist at FHB as active single products.
 * A wrong id at FHB is permanent, so the mode gate matters: in DRY_RUN this only records the exact payload.
 */

const Input = z.object({
  connectionId: z.string().min(1).max(64),
  productId: z.string().min(1).max(64),
  /** A human-entered EAN to push on UPDATE (never synced data). */
  explicitEan: z
    .string()
    .trim()
    .regex(/^\d{8,14}$/)
    .optional(),
  /** Rename at FHB (`new_id`). */
  newVendorId: z.string().trim().min(1).max(100).optional(),
  /** Multi-product components: CRM products and quantities. */
  components: z
    .array(z.object({ productId: z.string().min(1).max(64), quantity: z.number().int().min(1).max(10_000) }))
    .max(100)
    .optional(),
});
export type QueueFhbProductInput = z.input<typeof Input>;

export async function queueFhbProduct(actor: ScopedActor, raw: QueueFhbProductInput) {
  assertCan(actor.role, "vendorProducts.write");
  const input = Input.parse(raw);
  const result = await withAccountTransaction(actor.accountId, async (tx) => {
    const connection = await tx.fulfillmentConnection.findUnique({ where: { id: input.connectionId } });
    if (!connection || connection.type !== "FHB_V3") throw new DomainError("not_found");
    assertConnectionInScope(actor, connection.companyId);
    const product = await tx.product.findUnique({
      where: { id: input.productId },
      include: { eans: { orderBy: { createdAt: "asc" }, take: 1 } },
    });
    if (!product || product.archived) throw new DomainError("not_found");

    const linked = await tx.vendorProduct.findFirst({
      where: { connectionId: connection.id, productId: product.id, archived: false },
    });
    const vendorProductId = linked?.vendorId ?? fhbProductId(product.sku, connection.skuPrefixRule);
    // A product already at FHB under this id but not linked yet: update it (and link it on apply).
    const existing =
      linked ??
      (await tx.vendorProduct.findUnique({
        where: { connectionId_vendorId: { connectionId: connection.id, vendorId: vendorProductId } },
      }));
    const currentType = (existing?.raw as { type?: string } | null)?.type ?? null;

    let components: { id: string; quantity: number; exists: boolean; type: string | null }[] | undefined;
    if (input.components) {
      const vps = await tx.vendorProduct.findMany({
        where: { connectionId: connection.id, productId: { in: input.components.map((c) => c.productId) } },
      });
      components = input.components.map((c) => {
        const vp =
          vps.find((v) => v.productId === c.productId && !v.archived) ??
          vps.find((v) => v.productId === c.productId);
        return {
          id: vp?.vendorId ?? `?${c.productId}`,
          quantity: c.quantity,
          exists: !!vp && !vp.archived && !!vp.lastSyncAt,
          type: (vp?.raw as { type?: string } | null)?.type ?? null,
        };
      });
    }

    const draft = {
      vendorProductId,
      name: product.name,
      photo: product.images[0] ?? null,
      notifyUrl: fhbStockNotifyUrl(connection.id, publicBaseUrl()),
      hsCode: product.hsCode,
      countryOfOrigin: product.countryOfOrigin,
      components: components?.map(({ id, quantity }) => ({ id, quantity })),
    };
    const findings = validateFhbProduct({
      vendorProductId: input.newVendorId ?? vendorProductId,
      name: draft.name,
      photo: draft.photo,
      notifyUrl: draft.notifyUrl,
      components,
      currentType,
      // Without components a multi-product keeps its type and components (spec: omitting both preserves them).
      targetType: components ? "multi" : currentType === "multi" ? undefined : "single",
    });
    if (hasHardBlock(findings)) throw new FhbPreflightError("fhb_preflight_failed", findings);

    const meta = { productId: product.id };
    if (!existing) {
      if (input.newVendorId) throw new DomainError("fhb_product_not_at_vendor");
      const body = buildFhbProductCreate({ ...draft, ean: product.eans[0]?.ean ?? null });
      const enq = await enqueueOutboundInTx(tx, {
        accountId: actor.accountId,
        connectionId: connection.id,
        operation: "fhb.product.create",
        idempotencyKey: `fhb.product.create:${vendorProductId}`,
        payload: { id: vendorProductId, body, meta } as unknown as Prisma.InputJsonValue,
        createdById: actor.userId,
      });
      return { ...enq, operation: "fhb.product.create", vendorProductId, findings };
    }
    const body = buildFhbProductUpdate({
      ...draft,
      explicitEan: input.explicitEan ?? null,
      newId: input.newVendorId ?? null,
    });
    const enq = await enqueueOutboundInTx(tx, {
      accountId: actor.accountId,
      connectionId: connection.id,
      operation: "fhb.product.update",
      idempotencyKey: `fhb.product.update:${vendorProductId}:${payloadHash(body)}`,
      payload: { id: vendorProductId, body, meta } as unknown as Prisma.InputJsonValue,
      createdById: actor.userId,
    });
    return { ...enq, operation: "fhb.product.update", vendorProductId, findings };
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: result.operation === "fhb.product.create" ? "fhb.product.create" : "fhb.product.update",
    entityType: "Product",
    entityId: input.productId,
    after: {
      connectionId: input.connectionId,
      vendorProductId: result.vendorProductId,
      requestId: result.request.id,
      explicitEan: input.explicitEan ?? null,
      newVendorId: input.newVendorId ?? null,
      components: input.components?.length ?? 0,
    },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return result;
}
