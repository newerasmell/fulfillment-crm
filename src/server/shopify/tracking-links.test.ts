import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/auth/rbac";
import { accountDb } from "@/server/db/client";
import { euTestGroup } from "@/server/eushipments/test-fixtures";
import { applyNoCarrierRule, noCarrierKey } from "./carrier-company";
import {
  applyTrackingTemplate,
  deleteNoCarrierRule,
  listCarrierTrackingLinks,
  listNoCarrierRules,
  saveCarrierTrackingLink,
  trackingUrlFor,
} from "./tracking-links";

describe("tracking link templates", () => {
  it("puts the number (URL-encoded) in place of {tracking}", () => {
    expect(applyTrackingTemplate("https://t.example/?parcel={tracking}", "13239407935697")).toBe(
      "https://t.example/?parcel=13239407935697",
    );
    expect(applyTrackingTemplate("https://t.example/{tracking}/{tracking}", "A B")).toBe(
      "https://t.example/A%20B/A%20B",
    );
  });

  describe("database", () => {
    let g: Awaited<ReturnType<typeof euTestGroup>>;
    beforeAll(async () => {
      g = await euTestGroup("tracking-links");
      const { euTestOrder } = await import("@/server/eushipments/test-fixtures");
      const { order } = await euTestOrder(g, { number: "#TL-1" });
      await g.db.fulfillment.create({
        data: {
          accountId: g.accountId,
          orderId: order.id,
          connectionId: g.connection.id,
          externalId: "TL-1",
          status: "SHIPPED",
          carrier: "DPD Baltics EE",
          trackingNumbers: ["13239407935697"],
          trackingUrls: ["https://warehouse.example/track/abc"],
        },
      });
    });

    it("lists couriers with a recent number; saves, validates and clears a template (OWNER/ADMIN, audited)", async () => {
      const rows = await listCarrierTrackingLinks(g.accountId);
      expect(rows.find((r) => r.carrierName === "DPD Baltics EE")).toMatchObject({
        shipments: 1,
        shopifyCompany: "DPD",
        urlTemplate: null,
        sampleNumber: "13239407935697",
        sampleWarehouseUrl: "https://warehouse.example/track/abc",
      });
      await expect(
        saveCarrierTrackingLink(
          { ...g.owner, role: "OPERATOR" },
          { carrierName: "DPD Baltics EE", urlTemplate: "https://t.example/{tracking}" },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
      for (const bad of [
        "https://t.example/no-placeholder",
        "http://t.example/{tracking}",
        "javascript:{tracking}",
      ])
        await expect(
          saveCarrierTrackingLink(g.owner, { carrierName: "DPD Baltics EE", urlTemplate: bad }),
        ).rejects.toThrow();
      await saveCarrierTrackingLink(g.owner, {
        carrierName: "DPD Baltics EE",
        urlTemplate: " https://tracking.example/?parcel={tracking} ",
      });
      // Matched by the courier name in any case / spacing.
      expect(await trackingUrlFor(accountDb(g.accountId), g.accountId, "dpd  baltics ee", "123")).toBe(
        "https://tracking.example/?parcel=123",
      );
      expect(await trackingUrlFor(accountDb(g.accountId), g.accountId, "Other courier", "123")).toBeNull();
      await saveCarrierTrackingLink(g.owner, { carrierName: "DPD Baltics EE", urlTemplate: "" });
      expect(await trackingUrlFor(accountDb(g.accountId), g.accountId, "DPD Baltics EE", "123")).toBeNull();
      expect(
        await g.db.auditLog.count({ where: { action: "carrier.tracking_link", entityId: "dpd baltics ee" } }),
      ).toBe(2);
    });
    it("no-courier rules: listed with warehouse, country and company; forgotten by OWNER/ADMIN only (audited)", async () => {
      const key = noCarrierKey(g.connection.id, "hu", g.company.id);
      await g.db.shopifyCarrierAlias.create({
        data: { accountId: g.accountId, carrierKey: key, carrierName: "NOCARRIER HU", company: "DPD" },
      });
      expect(await listNoCarrierRules({ accountId: g.accountId, companyScope: null })).toEqual([
        expect.objectContaining({
          carrierKey: key,
          company: "DPD",
          connectionName: g.connection.name,
          countryCode: "HU",
          companyName: g.company.name,
        }),
      ]);
      // A person scoped to another company does not see it.
      expect(await listNoCarrierRules({ accountId: g.accountId, companyScope: ["other-company"] })).toEqual(
        [],
      );
      expect(await listNoCarrierRules({ accountId: g.accountId, companyScope: [g.company.id] })).toHaveLength(
        1,
      );
      // Named-courier aliases are not listed here.
      await g.db.shopifyCarrierAlias.create({
        data: {
          accountId: g.accountId,
          carrierKey: "some courier",
          carrierName: "Some Courier",
          company: "GLS",
        },
      });
      expect(await listNoCarrierRules({ accountId: g.accountId, companyScope: null })).toHaveLength(1);
      await expect(deleteNoCarrierRule({ ...g.owner, role: "OPERATOR" }, key)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(deleteNoCarrierRule(g.owner, "some courier")).rejects.toThrow();
      expect(await deleteNoCarrierRule(g.owner, key)).toEqual({ deleted: true });
      expect(await deleteNoCarrierRule(g.owner, key)).toEqual({ deleted: false });
      expect(await listNoCarrierRules({ accountId: g.accountId, companyScope: null })).toEqual([]);
      expect(await g.db.shopifyCarrierAlias.count({ where: { carrierKey: "some courier" } })).toBe(1);
      expect(
        await g.db.auditLog.count({ where: { action: "carrier.nocarrier_rule_deleted", entityId: key } }),
      ).toBe(1);
      await g.db.shopifyCarrierAlias.deleteMany({});
    });
  });

  it("applyNoCarrierRule: a courier name written meanwhile wins over the rule", async () => {
    const fake = {
      shopifyCarrierAlias: { findUnique: async () => ({ company: "Speedy" }) },
      fulfillment: {
        updateMany: async () => ({ count: 0 }),
        findFirst: async () => ({ carrier: "DPD Hungary" }),
      },
    };
    const f = { id: "f1", carrier: null, connectionId: "c1", countryCode: "HU", companyId: "co1" };
    expect(await applyNoCarrierRule(fake as never, "a1", f)).toBe("DPD Hungary");
    expect(await applyNoCarrierRule(fake as never, "a1", { ...f, carrier: "GLS" })).toBe("GLS");
  });
});
