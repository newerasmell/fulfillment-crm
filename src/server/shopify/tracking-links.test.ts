import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/auth/rbac";
import { accountDb } from "@/server/db/client";
import { euTestGroup } from "@/server/eushipments/test-fixtures";
import {
  applyTrackingTemplate,
  listCarrierTrackingLinks,
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
  });
});
