// Synthetic FHB mirror for the e2e run (no FHB calls): one connection with products, stock, movements,
// orders (one in RMA), a COD row, a local return, carriers, pick-up points and a DRY_RUN outbox request.
import { createFhbConnection } from "@/server/fhb/connection";
import { systemDb } from "@/server/db/client";

export async function seedFhb(owner: { userId: string; accountId: string }, companyId: string) {
  const sys = systemDb();
  const accountId = owner.accountId;
  const c = await createFhbConnection(
    { userId: owner.userId, accountId, role: "OWNER" },
    { companyId, name: "FHB Демо", appId: "e2e-app-id", secret: "e2e-fhb-secret-not-real", skuPrefix: "R" },
  );
  await sys.fulfillmentConnection.update({ where: { id: c.id }, data: { liveMode: "DRY_RUN" } });
  const connectionId = c.id;
  const now = new Date();
  const master = await sys.product.create({
    data: { accountId, sku: "SYN-EDP-50", name: "Синтетичен парфюм EDP 50 мл" },
  });
  await sys.productEan.create({ data: { accountId, productId: master.id, ean: "0000000000017" } });
  const vp1 = await sys.vendorProduct.create({
    data: {
      accountId,
      connectionId,
      productId: master.id,
      vendorId: "RSYN-EDP-50",
      vendorCode: "RTM0001",
      vendorEan: "0000000000024",
      lastSyncAt: now,
      raw: { id: "RSYN-EDP-50", name: "Synthetic EDP 50", type: "single" },
    },
  });
  await sys.stockLevel.create({
    data: {
      accountId,
      vendorProductId: vp1.id,
      physical: 12,
      free: 9,
      sellable: 9,
      snapshotAt: now,
      source: "POLL",
    },
  });
  const vp2 = await sys.vendorProduct.create({
    data: {
      accountId,
      connectionId,
      vendorId: "RSYN-UNLINKED",
      vendorCode: "RTM0002",
      lastSyncAt: now,
      raw: { id: "RSYN-UNLINKED", name: "Synthetic unlinked tester", type: "single" },
    },
  });
  await sys.stockLevel.create({
    data: {
      accountId,
      vendorProductId: vp2.id,
      physical: 0,
      free: 0,
      sellable: 0,
      snapshotAt: now,
      source: "POLL",
    },
  });
  await sys.stockMovement.create({
    data: {
      accountId,
      connectionId,
      vendorProductId: vp1.id,
      externalId: "9001",
      kind: "out",
      quantity: -2,
      occurredAt: now,
      raw: { product: "RSYN-EDP-50", quantity: 12, reason: "synthetic", order: "DM-1001" },
    },
  });
  const order = (
    externalId: string,
    rawStatus: string,
    status: "SHIPPED" | "RETURN_RECEIVED",
    extra = {},
  ) => ({
    accountId,
    connectionId,
    externalId,
    uid: `UID-${externalId}`,
    variableSymbol: externalId.replace(/\D/g, ""),
    rawStatus,
    status,
    parcelService: "gls",
    cod: 25.5,
    country: "SK",
    recipientName: "Test Buyer",
    trackingNumbers: [`TRK-${externalId}`],
    vendorCreatedAt: now,
    raw: {
      id: externalId,
      status: rawStatus,
      recipient: {
        address: {
          name: "Test Buyer",
          street: "Example street 1",
          city: "Testville",
          zip: "00000",
          country: "SK",
        },
      },
      items: [{ id: "RSYN-EDP-50", quantity: 1 }],
    },
    lastSyncAt: now,
    ...extra,
  });
  await sys.fhbOrderMirror.createMany({
    data: [
      order("DM-1001", "sent", "SHIPPED"),
      order("DM-1002", "returned", "RETURN_RECEIVED", { inRma: true, returnedAt: now, returnType: "return" }),
    ],
  });
  await sys.fhbCodMirror.create({
    data: {
      accountId,
      connectionId,
      externalId: "DM-1001",
      variableSymbol: "1001",
      parcelService: "gls",
      cod: 25.5,
      status: "waiting",
      vendorCreatedAt: now,
      raw: {},
      lastSyncAt: now,
    },
  });
  await sys.fhbReturnMirror.create({
    data: {
      accountId,
      connectionId,
      uid: "SYN00001",
      type: "complex",
      status: "stored",
      barcodes: ["SYNBARCODE1"],
      items: [{ description: "Synthetic item", quantity: 1, condition: "ok", action: "stock_in" }],
      photos: [],
      vendorCreatedAt: now,
      raw: {},
      lastSyncAt: now,
    },
  });
  await sys.fhbCarrier.createMany({
    data: [
      { accountId, connectionId, code: "gls", name: "GLS", lastSyncAt: now },
      { accountId, connectionId, code: "dpd_eu_pudo", name: "DPD PUDO", lastSyncAt: now },
    ],
  });
  await sys.fhbPickupPoint.create({
    data: {
      accountId,
      connectionId,
      service: "gls",
      queryCountry: "SK",
      vendorId: "777",
      name: "Synthetic Point",
      street: "Example street 2",
      city: "Testville",
      zip: "00000",
      country: "SK",
      lastSyncAt: now,
    },
  });
  for (const resource of ["products", "orders", "rma", "returns", "cod", "carriers"]) {
    await sys.fhbSyncState.create({
      data: { accountId, connectionId, resource, lastRunAt: now, lastOkAt: now, lastCount: 1 },
    });
  }
  await sys.outboundRequest.create({
    data: {
      accountId,
      connectionId,
      operation: "fhb.product.create",
      idempotencyKey: "fhb.product.create:RSYN-NEW",
      status: "DRY_RUN_RECORDED",
      evaluatedMode: "DRY_RUN",
      payload: {
        id: "RSYN-NEW",
        body: { id: "RSYN-NEW", name: "Synthetic new product", ean: "0000000000031" },
        meta: { productId: master.id },
      },
    },
  });
  return connectionId;
}
