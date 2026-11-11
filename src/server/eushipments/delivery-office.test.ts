import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/auth/rbac";
import { systemDb } from "@/server/db/client";
import {
  resolveDeliveryOffice,
  searchDeliveryOffices,
  setDeliveryOffice,
  deliveryOfficeView,
} from "./delivery-office";
import { euTestGroup, euTestOrder } from "./test-fixtures";
import { queueEuOrder } from "./write";

// Speedy offices for orders to BG (owner request 2026-11-11). Synthetic offices and orders only.
const OFFICE_LINE = "Office Speedy [275] ПЛЕВЕН - САН СТЕФАНО (УЛ.): ул. Сан Стефано No 35, Плевен, 5800, BG";
const COURIER = 7801;
const OTHER_COURIER = 7802;

describe("delivery to a Speedy office", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  let other: Awaited<ReturnType<typeof euTestGroup>>;
  let n = 0;
  const db = () => systemDb();

  beforeAll(async () => {
    g = await euTestGroup("delivery-office");
    other = await euTestGroup("delivery-office-other");
    const now = new Date();
    for (const grp of [g, other])
      await db().eushipmentsCountryCourier.create({
        data: {
          accountId: grp.accountId,
          connectionId: grp.connection.id,
          country: "BG",
          courierId: COURIER,
        },
      });
    await db().eushipmentsOffice.createMany({
      data: [
        { officeId: 88275, courierOfficeId: 275, name: "ПЛЕВЕН - САН СТЕФАНО (УЛ.)", courierId: COURIER },
        { officeId: 88247, courierOfficeId: 247, name: "ПЛЕВЕН - ХАДЖИ ДИМИТЪР (УЛ.)", courierId: COURIER },
        // Same name, another courier: never offered for this order's courier.
        {
          officeId: 88900,
          courierOfficeId: 275,
          name: "ПЛЕВЕН - САН СТЕФАНО (УЛ.)",
          courierId: OTHER_COURIER,
        },
      ].map((o) => ({ ...o, accountId: g.accountId, connectionId: g.connection.id, syncedAt: now })),
    });
    await db().eushipmentsOffice.create({
      data: {
        accountId: other.accountId,
        connectionId: other.connection.id,
        officeId: 77275,
        courierOfficeId: 275,
        name: "ПЛЕВЕН - САН СТЕФАНО (УЛ.)",
        courierId: COURIER,
        syncedAt: now,
      },
    });
    await db().countrySetting.upsert({
      where: { accountId_country: { accountId: g.accountId, country: "BG" } },
      create: { accountId: g.accountId, country: "BG", currency: "EUR" },
      update: {},
    });
  });

  /** A BG order with the office line, checked for g's warehouse, in `status`. */
  async function officeOrder(status: "NEEDS_REVIEW" | "APPROVED" = "NEEDS_REVIEW") {
    const { order, product } = await euTestOrder(g, { number: `#DO-${++n}` });
    await db().order.update({
      where: { id: order.id },
      data: {
        status,
        shippingAddress: { ...(order.shippingAddress as object), address1: OFFICE_LINE, address2: null },
      },
    });
    await db().orderCheck.create({
      data: {
        accountId: g.accountId,
        orderId: order.id,
        connectionId: g.connection.id,
        routing: { connectionId: g.connection.id, connectionType: "EUSHIPMENTS", carrier: null },
        findings: [],
      },
    });
    return { order: await db().order.findUniqueOrThrow({ where: { id: order.id } }), product };
  }

  it("recognised automatically; the view, search and a person's choice; never another courier's office", async () => {
    const { order } = await officeOrder();
    const view = await deliveryOfficeView(g.owner, order.id);
    expect(view?.resolution).toMatchObject({ kind: "office", officeId: 88275, source: "speedy_id" });
    const found = await searchDeliveryOffices(g.owner, order.id, "ПЛЕВЕН");
    expect(found.map((o) => o.officeId).sort()).toEqual([88247, 88275]);
    expect((await searchDeliveryOffices(g.owner, order.id, "247")).map((o) => o.officeId)).toEqual([88247]);
    // Another courier's office (same name) or another account's office: refused.
    for (const officeId of [88900, 77275])
      await expect(
        setDeliveryOffice(g.owner, {
          orderId: order.id,
          version: order.updatedAt.toISOString(),
          choice: { mode: "office", officeId, name: "x" },
        }),
      ).rejects.toMatchObject({ code: "office_unknown" });
    // A stale editor is refused.
    await expect(
      setDeliveryOffice(g.owner, { orderId: order.id, version: "2000-01-01T00:00:00.000Z", choice: null }),
    ).rejects.toMatchObject({ code: "stale" });
    await setDeliveryOffice(g.owner, {
      orderId: order.id,
      version: order.updatedAt.toISOString(),
      choice: { mode: "office", officeId: 88247, name: "ignored, the list's name is stored" },
    });
    const saved = await db().order.findUniqueOrThrow({ where: { id: order.id } });
    expect(saved.deliveryOffice).toEqual({
      mode: "office",
      officeId: 88247,
      name: "ПЛЕВЕН - ХАДЖИ ДИМИТЪР (УЛ.)",
      courierId: COURIER,
    });
    expect(
      await db().auditLog.count({ where: { entityId: order.id, action: "order.delivery_office" } }),
    ).toBe(1);
  });

  it("who and when: orders.review only, the member's companies only, never after approval", async () => {
    const { order } = await officeOrder();
    const input = { orderId: order.id, version: order.updatedAt.toISOString(), choice: null };
    await expect(setDeliveryOffice({ ...g.owner, role: "VIEWER" }, input)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      setDeliveryOffice({ ...g.owner, companyScope: ["other-company"] }, input),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await deliveryOfficeView({ ...g.owner, companyScope: ["other-company"] }, order.id)).toBeNull();
    const approved = await officeOrder("APPROVED");
    await expect(
      setDeliveryOffice(g.owner, {
        orderId: approved.order.id,
        version: approved.order.updatedAt.toISOString(),
        choice: { mode: "address" },
      }),
    ).rejects.toMatchObject({ code: "not_editable" });
  });

  it("'До адрес' on an office line is blocked; a chosen office gone from the list too; no courier → no office", async () => {
    const { order } = await officeOrder();
    const res = (deliveryOffice: unknown, courierId: number | null = COURIER) =>
      resolveDeliveryOffice(g.accountId, g.connection.id, courierId ?? undefined, {
        ...order,
        deliveryOffice,
      });
    expect(await res({ mode: "address" })).toMatchObject({ kind: "unresolved", reason: "address_is_office" });
    expect(await res({ mode: "office", officeId: 99999, name: "Стар офис" })).toMatchObject({
      kind: "unresolved",
      reason: "chosen_missing",
    });
    expect(await res({ mode: "office", officeId: 88247, name: "x" }, null)).toMatchObject({
      kind: "unresolved",
      reason: "no_courier",
    });
    expect(await res(null, null)).toMatchObject({ kind: "unresolved", reason: "no_courier" });
  });

  it("queued: the body and the shipment carry the office; queued again → still one outbox request", async () => {
    const { order, product } = await officeOrder("APPROVED");
    const vp = await db().vendorProduct.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        productId: product.id,
        vendorId: `ref-${product.sku}`,
      },
    });
    await db().stockLevel.create({
      data: {
        accountId: g.accountId,
        vendorProductId: vp.id,
        physical: 10,
        free: 10,
        sellable: 10,
        snapshotAt: new Date(),
        source: "POLL",
      },
    });
    const q = await queueEuOrder(g.owner, { orderId: order.id, connectionId: g.connection.id });
    expect(q.status).toBe("queued");
    if (q.status !== "queued") return;
    const f = await db().fulfillment.findUniqueOrThrow({ where: { id: q.fulfillmentId } });
    expect(f.deliveryPoint).toEqual({ officeId: 88275 });
    const req = await db().outboundRequest.findFirstOrThrow({ where: { fulfillmentId: f.id } });
    expect(
      (req.payload as { body: { recipient: { officeId: number; streetName: string | null } } }).body
        .recipient,
    ).toMatchObject({ officeId: 88275, streetName: null });
    await expect(
      queueEuOrder(g.owner, { orderId: order.id, connectionId: g.connection.id }),
    ).rejects.toBeTruthy();
    expect(await db().outboundRequest.count({ where: { fulfillmentId: f.id } })).toBe(1);
  });

  it("no courier set for BG: the search lists every office courier's offices; the pick decides the courier", async () => {
    const { order, product } = await officeOrder();
    const now = new Date();
    await db().eushipmentsCountryCourier.deleteMany({
      where: { connectionId: g.connection.id, country: "BG" },
    });
    await db().eushipmentsCountry.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        countryId: 359,
        name: "Bulgaria",
        isoCode: "BG",
        syncedAt: now,
      },
    });
    await db().eushipmentsCourier.createMany({
      data: [
        { courierId: COURIER, name: "Speedy(Bulgaria)", toOffice: true, toAddress: true },
        { courierId: OTHER_COURIER, name: "Econt(Bulgaria)", toOffice: true, toAddress: true },
        { courierId: 7899, name: "Address only", toOffice: false, toAddress: true },
      ].map((c) => ({
        ...c,
        accountId: g.accountId,
        connectionId: g.connection.id,
        country: "Bulgaria",
        syncedAt: now,
      })),
    });
    try {
      // Not chosen by itself: a person picks.
      expect((await deliveryOfficeView(g.owner, order.id))?.resolution).toMatchObject({
        kind: "unresolved",
        reason: "no_courier",
      });
      const found = await searchDeliveryOffices(g.owner, order.id, "САН СТЕФАНО");
      expect(found.map((o) => [o.officeId, o.courierName]).sort()).toEqual([
        [88275, "Speedy(Bulgaria)"],
        [88900, "Econt(Bulgaria)"],
      ]);
      const fresh = await db().order.findUniqueOrThrow({ where: { id: order.id } });
      // A courier that does not deliver to offices (or is not BG's) cannot be used.
      await expect(
        setDeliveryOffice(g.owner, {
          orderId: order.id,
          version: fresh.updatedAt.toISOString(),
          choice: { mode: "office", officeId: 88275, name: "x", courierId: 7899 },
        }),
      ).rejects.toMatchObject({ code: "office_unknown" });
      await setDeliveryOffice(g.owner, {
        orderId: order.id,
        version: fresh.updatedAt.toISOString(),
        choice: { mode: "office", officeId: 88275, name: "x", courierId: COURIER },
      });
      const saved = await db().order.findUniqueOrThrow({ where: { id: order.id } });
      expect(saved.deliveryOffice).toMatchObject({ officeId: 88275, courierId: COURIER });
      expect(await resolveDeliveryOffice(g.accountId, g.connection.id, undefined, saved)).toMatchObject({
        kind: "office",
        officeId: 88275,
        courierId: COURIER,
        source: "chosen",
      });
      // The body goes with the picked office's courier.
      const { previewEuOrderPayload } = await import("./write");
      void product;
      const body = await previewEuOrderPayload(g.accountId, {
        orderId: order.id,
        connectionId: g.connection.id,
      });
      expect(body).toMatchObject({ courierId: COURIER, recipient: { officeId: 88275 } });
      // …and the order is not blocked for a missing courier any more (the picked office's courier is checked).
      const { previewEuOrderFindings } = await import("./write");
      const codes = (
        await previewEuOrderFindings(g.accountId, { orderId: order.id, connectionId: g.connection.id })
      ).map((f) => f.code);
      expect(codes).not.toContain("courier_choice_missing");
      expect(codes).not.toContain("office_unresolved");
      // A stored pick without a courier (older data) and no courier for the country: a person picks again.
      expect(
        await resolveDeliveryOffice(g.accountId, g.connection.id, undefined, {
          ...saved,
          deliveryOffice: { mode: "office", officeId: 88275, name: "x" },
        }),
      ).toMatchObject({ kind: "unresolved", reason: "no_courier" });
      // A courier set later that is not the picked office's: picked again.
      expect(await resolveDeliveryOffice(g.accountId, g.connection.id, OTHER_COURIER, saved)).toMatchObject({
        kind: "unresolved",
        reason: "chosen_missing",
      });
    } finally {
      await db().eushipmentsCourier.deleteMany({ where: { connectionId: g.connection.id } });
      await db().eushipmentsCountry.deleteMany({ where: { connectionId: g.connection.id } });
      await db().eushipmentsCountryCourier.create({
        data: { accountId: g.accountId, connectionId: g.connection.id, country: "BG", courierId: COURIER },
      });
    }
  });
});
