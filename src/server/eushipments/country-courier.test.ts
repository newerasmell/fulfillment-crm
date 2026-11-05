import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/auth/rbac";
import { countryCourierBoard, setCountryCourier } from "./country-couriers";
import { euTestGroup, euTestOrder } from "./test-fixtures";
import { previewEuOrderFindings, previewEuOrderPayload } from "./write";

// Synthetic data only; nothing calls euShipments.

describe("euShipments default courier per country", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  let orderId: string;
  beforeAll(async () => {
    g = await euTestGroup("country-courier");
    const now = new Date();
    await g.db.eushipmentsCountry.createMany({
      data: [
        {
          accountId: g.accountId,
          connectionId: g.connection.id,
          countryId: 1,
          name: "Greece",
          isoCode: "GR",
          syncedAt: now,
        },
        {
          accountId: g.accountId,
          connectionId: g.connection.id,
          countryId: 2,
          name: "Romania",
          isoCode: "RO",
          syncedAt: now,
        },
      ],
    });
    await g.db.eushipmentsCourier.createMany({
      data: [
        {
          accountId: g.accountId,
          connectionId: g.connection.id,
          courierId: 501,
          name: "Greece Courier A",
          country: "Greece",
          toAddress: true,
          syncedAt: now,
        },
        {
          accountId: g.accountId,
          connectionId: g.connection.id,
          courierId: 502,
          name: "Greece Courier B",
          country: "Greece",
          toAddress: true,
          toOffice: true,
          syncedAt: now,
        },
        {
          accountId: g.accountId,
          connectionId: g.connection.id,
          courierId: 601,
          name: "Romania Courier",
          country: "Romania",
          toAddress: true,
          syncedAt: now,
        },
      ],
    });
    orderId = (await euTestOrder(g, { number: "#9301", country: "GR" })).order.id;
  });

  const input = () => ({ orderId, connectionId: g.connection.id });
  const codes = async () => (await previewEuOrderFindings(g.accountId, input())).map((f) => f.code);

  it("several couriers for the country and none chosen: blocked before sending; the board says so", async () => {
    expect(await codes()).toContain("courier_choice_missing");
    const board = await countryCourierBoard(g.accountId, g.connection.id);
    expect(board.map((b) => [b.iso, b.couriers.length, b.needsChoice])).toEqual([
      ["GR", 2, true],
      ["RO", 1, false],
    ]);
  });

  it("a default courier (and service) goes into create-order; clearing it blocks again", async () => {
    await expect(
      setCountryCourier(
        { ...g.owner, role: "OPERATOR" },
        { connectionId: g.connection.id, country: "gr", courierId: 502 },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      setCountryCourier(g.owner, { connectionId: g.connection.id, country: "GR", courierId: 999 }),
    ).rejects.toMatchObject({ code: "courier_unknown" });
    // A courier of another country is refused.
    await expect(
      setCountryCourier(g.owner, { connectionId: g.connection.id, country: "GR", courierId: 601 }),
    ).rejects.toMatchObject({ code: "courier_wrong_country" });
    await setCountryCourier(g.owner, {
      connectionId: g.connection.id,
      country: "gr",
      courierId: 502,
      serviceName: "crossborder",
    });
    expect(await codes()).not.toContain("courier_choice_missing");
    const body = await previewEuOrderPayload(g.accountId, input());
    expect(body).toMatchObject({ courierId: 502, serviceName: "crossborder" });
    expect((await countryCourierBoard(g.accountId, g.connection.id))[0]).toMatchObject({
      iso: "GR",
      courierId: 502,
      needsChoice: false,
    });
    expect(await g.db.auditLog.count({ where: { action: "eushipments.country_courier" } })).toBe(1);
    // An explicit courier from the caller wins over the default.
    expect(await previewEuOrderPayload(g.accountId, { ...input(), courierId: 501 })).toMatchObject({
      courierId: 501,
    });
    await setCountryCourier(g.owner, { connectionId: g.connection.id, country: "GR", courierId: null });
    expect(await codes()).toContain("courier_choice_missing");
  });

  it("another account cannot set a default on this connection", async () => {
    const other = await euTestGroup("country-courier-other");
    await expect(
      setCountryCourier(other.owner, { connectionId: g.connection.id, country: "GR", courierId: 501 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
