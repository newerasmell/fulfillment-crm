// Synthetic data for tests/e2e/labels.spec.ts (Ръчни пратки и етикети). Its own group and OWNER, so other specs'
// counts never change. No vendor is called: the web app only writes outbox rows, and no worker runs during e2e.
//   - "Joy Етикети" (FHB_JOY, CANARY, parcel services pplcz/packeta) + one label already created at Joy with a
//     stored synthetic PDF (status ACCEPTED), to test download and bulk print;
//   - "euShipments Етикети" (EUSHIPMENTS, LIVE, companyId 333) with one courier in the mirror, a product with a
//     vendor product and stock, for the AWB and "from stock" kinds.
import { bootstrapOwner } from "@/server/auth/users";
import { accountDb, systemDb, withAccountTransaction } from "@/server/db/client";
import { createManualShipment, createJoyConnection, storeLabel } from "@/server/labels";
import { saveCredential } from "@/server/security/credentials";

export const LABELS_PASSWORD = "e2e-labels-password-not-secret";
const PDF = Buffer.from("%PDF-1.4\n% synthetic e2e label\n").toString("base64");

export async function seedLabels() {
  const owner = await bootstrapOwner({
    email: "e2e-labels@example.com",
    name: "E2E Labels",
    accountName: "Тест група Етикети",
    password: LABELS_PASSWORD,
  });
  const sys = systemDb();
  const accountId = owner.account.id;
  const actor = { userId: owner.user.id, accountId, role: "OWNER" as const, companyScope: null };
  const company = await sys.company.findFirstOrThrow({ where: { accountId } });
  await sys.countrySetting.createMany({
    data: [
      { accountId, country: "CZ", currency: "CZK" },
      { accountId, country: "BG", currency: "EUR" },
    ],
  });
  const joy = await createJoyConnection(actor, {
    companyId: company.id,
    name: "Joy Етикети",
    appId: "e2e-joy-app-id",
    secret: "e2e-joy-secret-not-real",
    settings: { parcelServices: ["pplcz", "packeta"], pickupServices: ["packeta"] },
  });
  await sys.fulfillmentConnection.update({ where: { id: joy.id }, data: { liveMode: "LIVE" } });

  const cred = await saveCredential(accountDb(accountId), accountId, {
    label: "eu",
    secret: "e2e-eu-labels-token-not-real",
  });
  const eu = await sys.fulfillmentConnection.create({
    data: {
      accountId,
      companyId: company.id,
      type: "EUSHIPMENTS",
      name: "euShipments Етикети",
      credentialId: cred.id,
      vendorIds: { companyId: 333 },
      liveMode: "LIVE",
    },
  });
  await sys.eushipmentsCourier.create({
    data: {
      accountId,
      connectionId: eu.id,
      courierId: 20,
      name: "Тест куриер",
      toOffice: true,
      toAddress: true,
      country: "BG",
      syncedAt: new Date(),
    },
  });
  const product = await sys.product.create({
    data: { accountId, sku: "SYN-LBL-EDP-50", name: "Синтетичен парфюм етикети 50 мл", weightGrams: 400 },
  });
  const vp = await sys.vendorProduct.create({
    data: {
      accountId,
      connectionId: eu.id,
      productId: product.id,
      vendorId: "ref-SYN-LBL-EDP-50",
      lastSyncAt: new Date(),
    },
  });
  await sys.stockLevel.create({
    data: {
      accountId,
      vendorProductId: vp.id,
      physical: 9,
      free: 9,
      sellable: 9,
      snapshotAt: new Date(),
      source: "POLL",
    },
  });

  // One label already printed at Joy (as if the worker had sent it): stored PDF, tracking number.
  const r = await createManualShipment(actor, {
    kind: "JOY_LABEL",
    companyId: company.id,
    connectionId: joy.id,
    recipient: {
      name: "Seed Recipient",
      email: "seed-recipient@example.com",
      phone: "+420601000111",
      address1: "Seed Street 1",
      city: "Testov",
      zip: "75501",
      countryCode: "CZ",
    },
    cod: null,
    currency: "CZK",
    parcels: 1,
    weights: [1],
    parcelService: "pplcz",
  });
  await withAccountTransaction(accountId, async (tx) => {
    await tx.outboundRequest.updateMany({
      where: { fulfillmentId: r.fulfillmentId! },
      data: { status: "SENT", sentAt: new Date(), evaluatedMode: "LIVE" },
    });
    await tx.fulfillment.update({
      where: { id: r.fulfillmentId! },
      data: { status: "ACCEPTED", rawStatus: "pending", trackingNumbers: ["E2E-TRACK-0001"] },
    });
    await tx.order.update({ where: { id: r.orderId }, data: { status: "ACCEPTED" } });
    await storeLabel(tx, {
      accountId,
      connectionId: joy.id,
      fulfillmentId: r.fulfillmentId!,
      source: "joy.create",
      base64: PDF,
    });
  });
  // From here on the Joy connection is in CANARY: a new label waits for an explicit confirmation.
  await sys.fulfillmentConnection.update({ where: { id: joy.id }, data: { liveMode: "CANARY" } });
  return {
    email: owner.user.email,
    password: LABELS_PASSWORD,
    totp: owner.totpSecret,
    seededNumber: r.number,
  };
}
