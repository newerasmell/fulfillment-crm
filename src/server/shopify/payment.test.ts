import { beforeAll, describe, expect, it } from "vitest";
import { SYNTHETIC_ORDERS } from "@/integrations/shopify/__fixtures__/orders";
import { ForbiddenError } from "@/server/auth/rbac";
import { checkOrder } from "@/server/checks";
import { paymentUnclear } from "@/server/checks/order-checks";
import { euTestGroup } from "@/server/eushipments/test-fixtures";
import { previewEuOrderFindings } from "@/server/eushipments/write";
import { updateStoreSettings } from "@/server/stores";
import { importShopifyOrder } from "./orders";
import { classifyPayment, markOrderGatewaysCod, shopifyPaymentOf } from "./payment";

// Synthetic data only; nothing calls Shopify or a warehouse. "Αντικαταβολή" stands for a store's own local-language
// cash-on-delivery method name.

const LOCAL_COD = "Αντικαταβολή (συνθετικό)";

describe("payment facts (pure)", () => {
  const raw = { paymentGatewayNames: [LOCAL_COD], totalOutstandingSet: { shopMoney: { amount: "45.00" } } };
  it("reads gateways and the amount owed; classifies by the store's COD list", () => {
    expect(shopifyPaymentOf(raw)).toEqual({ gateways: [LOCAL_COD], outstanding: 45 });
    expect(shopifyPaymentOf(null)).toBeNull();
    expect(classifyPayment(raw, ["Cash on Delivery (COD)"])).toEqual({ cod: false, codAmount: null });
    expect(classifyPayment(raw, [LOCAL_COD.toUpperCase()])).toEqual({ cod: true, codAmount: "45.00" });
    // Nothing owed: never COD, whatever the gateway.
    expect(
      classifyPayment({ ...raw, totalOutstandingSet: { shopMoney: { amount: "0.00" } } }, [LOCAL_COD]),
    ).toEqual({ cod: false, codAmount: null });
  });
  it("prepaid with money owed is unclear; COD or nothing owed is not", () => {
    const p = shopifyPaymentOf(raw);
    expect(paymentUnclear({ paymentMethod: "PREPAID", currency: "EUR", shopifyPayment: p })?.en).toContain(
      "45.00 EUR still owed",
    );
    expect(paymentUnclear({ paymentMethod: "COD", currency: "EUR", shopifyPayment: p })).toBeNull();
    expect(
      paymentUnclear({
        paymentMethod: "PREPAID",
        currency: "EUR",
        shopifyPayment: { gateways: ["card"], outstanding: 0 },
      }),
    ).toBeNull();
  });
});

describe("custom local-language COD methods (database)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  beforeAll(async () => {
    g = await euTestGroup("payment");
    await g.db.countrySetting.create({ data: { accountId: g.accountId, country: "BG", currency: "EUR" } });
  });

  it("an unknown COD name is never shipped as prepaid; marking it COD re-classifies and re-checks", async () => {
    const store = await g.db.store.findUniqueOrThrow({ where: { id: g.store.id } });
    const base = SYNTHETIC_ORDERS[0]!;
    const { orderId } = await importShopifyOrder(g.accountId, store, {
      ...base,
      paymentGatewayNames: [LOCAL_COD],
    });
    const o0 = await g.db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(o0.paymentMethod).toBe("PREPAID");
    await g.db.order.update({ where: { id: orderId }, data: { status: "IMPORTED" } });
    const r = await checkOrder(g.accountId, orderId, { actor: { kind: "system" } });
    expect(r.findings.find((f) => f.code === "order.payment_unclear")).toMatchObject({ severity: "hard" });
    // The warehouse pre-flight blocks it too (an order checked before this rule existed).
    expect(
      (await previewEuOrderFindings(g.accountId, { orderId, connectionId: g.connection.id })).map(
        (f) => f.code,
      ),
    ).toContain("payment_unclear");

    await expect(markOrderGatewaysCod({ ...g.owner, role: "OPERATOR" }, orderId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const marked = await markOrderGatewaysCod(g.owner, orderId);
    expect(marked).toEqual({ added: [LOCAL_COD], changed: 1 });
    const o = await g.db.order.findUniqueOrThrow({ where: { id: orderId }, include: { check: true } });
    expect(o.paymentMethod).toBe("COD");
    expect(o.codAmount?.toString()).toBe("45");
    expect((o.check?.findings as { code: string }[]).map((f) => f.code)).not.toContain(
      "order.payment_unclear",
    );
    expect((await g.db.store.findUniqueOrThrow({ where: { id: g.store.id } })).codGateways).toContain(
      LOCAL_COD,
    );
    expect(
      await g.db.auditLog.count({ where: { action: "order.payment_reclassified", entityId: orderId } }),
    ).toBe(1);

    // Removing it from the store settings re-classifies back; an order already at a warehouse is never touched.
    const shipped = await importShopifyOrder(g.accountId, store, {
      ...SYNTHETIC_ORDERS[1]!,
      paymentGatewayNames: [LOCAL_COD],
      totalOutstandingSet: { shopMoney: { amount: "20.00", currencyCode: "EUR" } },
    } as typeof base);
    await g.db.order.update({ where: { id: shipped.orderId }, data: { status: "ACCEPTED" } });
    const before = await g.db.order.findUniqueOrThrow({ where: { id: shipped.orderId } });
    const s = await g.db.store.findUniqueOrThrow({ where: { id: g.store.id } });
    await updateStoreSettings(g.owner, g.store.id, {
      name: s.name,
      countries: s.countries,
      codGateways: s.codGateways.filter((x) => x !== LOCAL_COD),
      skuPrefix: s.skuPrefix ?? "",
      notifyCustomer: s.notifyCustomer,
      fulfilTrigger: s.fulfilTrigger,
      writeBackMode: s.writeBackMode,
      inventoryPushMode: s.inventoryPushMode,
      inventoryBuffer: s.inventoryBuffer,
    } as never);
    expect((await g.db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentMethod).toBe("PREPAID");
    expect((await g.db.order.findUniqueOrThrow({ where: { id: shipped.orderId } })).paymentMethod).toBe(
      before.paymentMethod,
    );
  });
});
