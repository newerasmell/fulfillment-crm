import { beforeAll, describe, expect, it } from "vitest";
import { compactPhone, internationalPhone, waivedPhone } from "@/lib/phone-waiver";
import { ForbiddenError } from "@/server/auth/rbac";
import { systemDb } from "@/server/db/client";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import { previewEuOrderFindings, previewEuOrderPayload } from "@/server/eushipments/write";
import { allowOrderPhone, revokeOrderPhone } from "./phone-waiver";

// "Позволи за тази поръчка" for a phone (owner request 2026-11-18). Synthetic numbers only.
describe("phone waiver helpers", () => {
  it("compacts and puts a number with its country code in international form", () => {
    expect(compactPhone(" +358 40 661-3033 ")).toBe("+358406613033");
    expect(compactPhone("00358 (40) 6613033")).toBe("+358406613033");
    expect(internationalPhone("+358 40 6613033")).toBe("+358406613033");
    expect(internationalPhone("040 6613033")).toBeNull(); // no country code
    expect(internationalPhone("+0123456789")).toBeNull();
    expect(internationalPhone("+1234567890123456")).toBeNull(); // > 15 digits
  });
  it("applies only to the very phone it was given for", () => {
    const w = { phoneKey: "+358406613033", sentPhone: "+358406613033" };
    expect(waivedPhone(w, "+358 40 6613033")).toBe("+358406613033");
    expect(waivedPhone(w, "+358 40 6613034")).toBeNull();
    expect(waivedPhone(null, "+358 40 6613033")).toBeNull();
  });
});

const KEY = "+358406613033";

describe("allow an order's phone (euShipments)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  const db = () => systemDb();

  beforeAll(async () => {
    g = await euTestGroup("phone-waiver");
  });

  /** A Croatian address with a Finnish mobile (another country's code): euShipments' HR rule refuses it. */
  async function foreignPhoneOrder(number: string, phone = "+358 40 6613033") {
    const { order } = await euTestOrder(g, { number, country: "HR", phone });
    await db().order.update({
      where: { id: order.id },
      data: {
        status: "READY",
        shippingAddress: { ...(order.shippingAddress as object), phone },
      },
    });
    return order;
  }
  const input = (orderId: string) => ({ orderId, connectionId: g.connection.id });
  const phoneBlocks = async (orderId: string) =>
    (await previewEuOrderFindings(g.accountId, input(orderId))).filter((f) => f.code === "phone_invalid");

  it("blocks, then sends the phone as written once a person allows it; a changed phone blocks again", async () => {
    const order = await foreignPhoneOrder("#PW1");
    expect(await phoneBlocks(order.id)).toHaveLength(1);

    await expect(
      allowOrderPhone(
        { ...g.owner, role: "VIEWER" as never },
        { orderId: order.id, reason: "потвърдено", phoneKey: KEY },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      allowOrderPhone(g.owner, { orderId: order.id, reason: "", phoneKey: KEY }),
    ).rejects.toThrow();

    const r = await allowOrderPhone(
      { ...g.owner, role: "OPERATOR" },
      { orderId: order.id, reason: "клиентът потвърди номера", phoneKey: KEY },
    );
    expect(r.sentPhone).toBe("+358406613033");
    expect(await phoneBlocks(order.id)).toHaveLength(0);
    // Only the phone: every other check still applies (a line without a euShipments product blocks).
    expect((await previewEuOrderFindings(g.accountId, input(order.id))).map((f) => f.code)).toEqual(
      expect.not.arrayContaining(["phone_invalid"]),
    );
    expect(await previewEuOrderPayload(g.accountId, input(order.id))).toMatchObject({
      recipient: { phoneNumber: "+358406613033" },
    });
    expect(await db().auditLog.count({ where: { entityId: order.id, action: "order.phone_waived" } })).toBe(
      1,
    );

    // Another phone on the order: the waiver no longer applies.
    await db().order.update({
      where: { id: order.id },
      data: { shippingAddress: { ...((order.shippingAddress ?? {}) as object), phone: "+358 40 1111111" } },
    });
    expect(await phoneBlocks(order.id)).toHaveLength(1);
  });

  it("taking it back blocks again; refused for a number without a country code, an order already sent, another company", async () => {
    const order = await foreignPhoneOrder("#PW2");
    await allowOrderPhone(g.owner, { orderId: order.id, reason: "потвърдено", phoneKey: KEY });
    expect(await phoneBlocks(order.id)).toHaveLength(0);
    await revokeOrderPhone(g.owner, order.id);
    expect(await phoneBlocks(order.id)).toHaveLength(1);
    expect(
      await db().auditLog.count({ where: { entityId: order.id, action: "order.phone_waiver_revoked" } }),
    ).toBe(1);

    const local = await foreignPhoneOrder("#PW3", "040 6613033");
    await expect(
      allowOrderPhone(g.owner, { orderId: local.id, reason: "потвърдено", phoneKey: KEY }),
    ).rejects.toMatchObject({
      code: "phone_not_international",
    });

    // Allowed twice: one waiver, two audit rows; taking back a waiver that is not there changes nothing.
    await allowOrderPhone(g.owner, { orderId: order.id, reason: "първо", phoneKey: KEY });
    await allowOrderPhone(g.owner, { orderId: order.id, reason: "второ", phoneKey: KEY });
    expect(await db().orderPhoneWaiver.count({ where: { orderId: order.id } })).toBe(1);
    await revokeOrderPhone(g.owner, order.id);
    await revokeOrderPhone(g.owner, order.id);
    expect(
      await db().auditLog.count({ where: { entityId: order.id, action: "order.phone_waiver_revoked" } }),
    ).toBe(2);

    // The phone changed after the person saw it: refused.
    await expect(
      allowOrderPhone(g.owner, { orderId: order.id, reason: "потвърдено", phoneKey: "+358401111111" }),
    ).rejects.toMatchObject({ code: "phone_changed" });

    // Another account's user cannot see the order.
    const other = await euTestGroup("phone-waiver-other");
    await expect(
      allowOrderPhone(other.owner, { orderId: order.id, reason: "потвърдено", phoneKey: KEY }),
    ).rejects.toMatchObject({ code: "not_found" });

    const sent = await foreignPhoneOrder("#PW4");
    await db().order.update({ where: { id: sent.id }, data: { status: "QUEUED" } });
    await expect(
      allowOrderPhone(g.owner, { orderId: sent.id, reason: "потвърдено", phoneKey: KEY }),
    ).rejects.toMatchObject({
      code: "not_editable",
    });
    await expect(
      allowOrderPhone(
        { ...g.owner, companyScope: ["other"] },
        { orderId: order.id, reason: "потвърдено", phoneKey: KEY },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
