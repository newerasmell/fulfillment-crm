import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/auth/rbac";
import { checkOrder } from "@/server/checks";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import { importShopifyOrder } from "@/server/shopify/orders";
import { SYNTHETIC_ORDERS } from "@/integrations/shopify/__fixtures__/orders";
import {
  AddressEdit,
  DEFAULT_REASON_CODES,
  decideOrder,
  diffValues,
  editOrderAddress,
  editorValues,
  getOrderReview,
  listReasonCodes,
  listReviews,
  MAX_REVIEW_MS,
  mergeDiff,
  previewAddress,
  saveReasonCode,
  setReasonCodeActive,
  timeSpentMs,
} from "./index";

// Synthetic data only; nothing calls a vendor or Shopify.

describe("diff (pure)", () => {
  const before = editorValues(
    { name: "Test Buyer", address1: "Example 1", city: "Sofia", zip: null, countryCode: "bg" },
    "0888 123 456",
  );

  it("reports only changed fields, with finding paths", () => {
    const edit = AddressEdit.parse({ zip: " 1000 ", city: "Sofia", phone: "+359888123456" });
    expect(diffValues(before, edit)).toEqual([
      { field: "shippingAddress.zip", from: null, to: "1000", via: "manual" },
      { field: "phone", from: "0888 123 456", to: "+359888123456", via: "manual" },
    ]);
  });

  it("merges a session: first from, last to, reverted fields drop out", () => {
    const a = [{ field: "shippingAddress.zip" as const, from: null, to: "100", via: "manual" }];
    const b = [
      { field: "shippingAddress.zip" as const, from: "100", to: "1000", via: "manual" },
      { field: "phone" as const, from: "1", to: "2", via: "suggested_fix:order.phone_invalid" },
    ];
    expect(mergeDiff(a, b)).toEqual([
      { field: "shippingAddress.zip", from: null, to: "1000", via: "manual" },
      { field: "phone", from: "1", to: "2", via: "suggested_fix:order.phone_invalid" },
    ]);
    expect(mergeDiff(b, [{ field: "phone", from: "2", to: "1" }])).toHaveLength(1);
  });

  it("validates the editor input", () => {
    expect(() => AddressEdit.parse({ countryCode: "BGR" })).toThrow();
    expect(() => AddressEdit.parse({ street: "x" })).toThrow();
    expect(AddressEdit.parse({ countryCode: "ro", address2: "  " })).toEqual({
      countryCode: "RO",
      address2: null,
    });
  });

  it("time spent is clamped and never trusts a future clock", () => {
    const now = new Date("2026-11-02T12:00:00Z");
    expect(timeSpentMs("2026-11-02T11:59:00Z", now)).toBe(60_000);
    expect(timeSpentMs("2026-11-01T00:00:00Z", now)).toBe(MAX_REVIEW_MS);
    expect(timeSpentMs("2026-11-02T13:00:00Z", now)).toBeNull();
    expect(timeSpentMs(null, now)).toBeNull();
  });
});

describe("review service (database)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;

  const mapStock = async (productId: string, free = 50) => {
    const vp = await g.db.vendorProduct.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        productId,
        vendorId: `ref-${productId}`,
      },
    });
    await g.db.stockLevel.create({
      data: {
        accountId: g.accountId,
        vendorProductId: vp.id,
        physical: free,
        free,
        sellable: free,
        snapshotAt: new Date(),
        source: "POLL",
      },
    });
  };
  /** A checked order: clean (READY) or with a missing zip (hard finding, NEEDS_REVIEW). */
  const checked = async (number: string, opts: { missingZip?: boolean } = {}) => {
    // Distinct contact per order, so the duplicate check (same phone + total) stays quiet.
    const { order, product } = await euTestOrder(g, { number, phone: `0888 123 ${number.slice(-3)}` });
    await mapStock(product.id);
    const address = order.shippingAddress as Record<string, string | null>;
    await g.db.order.update({
      where: { id: order.id },
      data: {
        status: "IMPORTED",
        email: `buyer${number.slice(1)}@example.com`,
        shippingAddressOriginal: address,
        ...(opts.missingZip ? { shippingAddress: { ...address, zip: null } } : {}),
      },
    });
    await checkOrder(g.accountId, order.id, { actor: { kind: "system" } });
    return g.db.order.findUniqueOrThrow({ where: { id: order.id } });
  };
  const opened = () => new Date(Date.now() - 90_000).toISOString();

  beforeAll(async () => {
    g = await euTestGroup("review");
    await g.db.countrySetting.create({ data: { accountId: g.accountId, country: "BG", currency: "EUR" } });
  });

  it("approve is refused while a hard finding exists; nothing is recorded", async () => {
    const o = await checked("#3001", { missingZip: true });
    expect(o.status).toBe("NEEDS_REVIEW");
    await expect(
      decideOrder(g.owner, { orderId: o.id, decision: "approve", reasonCode: "all_ok", openedAt: opened() }),
    ).rejects.toMatchObject({ code: "hard_findings" });
    expect(await g.db.review.count({ where: { orderId: o.id } })).toBe(0);
    expect((await g.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("NEEDS_REVIEW");
  });

  it("edit → re-check → approve stores EDIT_AND_APPROVE with the diff, reason, findings seen and time", async () => {
    const o = await checked("#3002", { missingZip: true });
    const preview = await previewAddress(g.owner, o.id, { zip: "" });
    expect(preview.findings.map((f) => f.code)).toContain("order.address.zip_missing");
    expect((await previewAddress(g.owner, o.id, { zip: "1000" })).findings).toEqual([]);

    const r = await editOrderAddress(g.owner, o.id, {
      values: { zip: "1000" },
      version: o.updatedAt.toISOString(),
    });
    expect(r).toMatchObject({ status: "READY", hardCount: 0 });
    expect(r.changed).toEqual([{ field: "shippingAddress.zip", from: null, to: "1000", via: "manual" }]);
    const after = await g.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect((after.shippingAddress as { zip: string }).zip).toBe("1000");
    expect((after.shippingAddressOriginal as { zip: string }).zip).toBe("1000"); // original untouched
    expect(await g.db.auditLog.count({ where: { entityId: o.id, action: "order.address_edited" } })).toBe(1);

    const d = await decideOrder(g.owner, {
      orderId: o.id,
      decision: "approve",
      reasonCode: "address_fixed",
      openedAt: opened(),
    });
    expect(d).toMatchObject({ decision: "EDIT_AND_APPROVE", status: "APPROVED" });
    const review = await g.db.review.findUniqueOrThrow({ where: { id: d.reviewId } });
    expect(review).toMatchObject({
      decision: "EDIT_AND_APPROVE",
      reasonCode: "address_fixed",
      reviewerId: g.owner.userId,
    });
    expect(review.diff).toEqual([{ field: "shippingAddress.zip", from: null, to: "1000", via: "manual" }]);
    expect((review.findings as { code: string }[]).map((f) => f.code)).toContain("order.address.zip_missing");
    expect(review.timeSpentMs).toBeGreaterThanOrEqual(89_000);
    expect(review.decidedAt).not.toBeNull();
    const ev = await g.db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, cause: "approve" } });
    expect(ev).toMatchObject({ toStatus: "APPROVED", source: "review", reason: "address_fixed" });
    expect((ev.meta as { reviewId: string }).reviewId).toBe(d.reviewId);
    // Approving only approves: no shipment, no outbox row.
    expect(await g.db.fulfillment.count({ where: { orderId: o.id } })).toBe(0);
    expect(await g.db.outboundRequest.count({ where: { connectionId: g.connection.id } })).toBe(0);
    // Approved orders are no longer editable.
    await expect(
      editOrderAddress(g.owner, o.id, { values: { zip: "1001" }, version: after.updatedAt.toISOString() }),
    ).rejects.toMatchObject({ code: "not_editable" });
  });

  it("a clean order is approved as APPROVE; a second decision is refused", async () => {
    const o = await checked("#3003");
    expect(o.status).toBe("READY");
    const d = await decideOrder(g.owner, { orderId: o.id, decision: "approve" });
    expect(d.decision).toBe("APPROVE");
    await expect(decideOrder(g.owner, { orderId: o.id, decision: "approve" })).rejects.toMatchObject({
      code: "already_decided",
    });
    expect(await g.db.review.count({ where: { orderId: o.id, decision: { not: null } } })).toBe(1);
  });

  it("hold and block need a reason valid for that decision; block cancels in the CRM only", async () => {
    const o = await checked("#3004");
    await expect(decideOrder(g.owner, { orderId: o.id, decision: "hold" })).rejects.toMatchObject({
      code: "reason_required",
    });
    await expect(
      decideOrder(g.owner, { orderId: o.id, decision: "hold", reasonCode: "duplicate_order" }),
    ).rejects.toMatchObject({ code: "reason_invalid" });
    await expect(
      decideOrder(g.owner, { orderId: o.id, decision: "hold", reasonCode: "other" }),
    ).rejects.toMatchObject({ code: "reason_text_required" });
    const h = await decideOrder(g.owner, {
      orderId: o.id,
      decision: "hold",
      reasonCode: "contact_customer",
      reasonText: "звъннете след 17:00",
    });
    expect(h).toMatchObject({ decision: "HOLD", status: "ON_HOLD" });
    const b = await decideOrder(g.owner, { orderId: o.id, decision: "block", reasonCode: "suspected_fraud" });
    expect(b).toMatchObject({ decision: "CANCEL", status: "CANCELLED" });
    const rows = await g.db.review.findMany({ where: { orderId: o.id }, orderBy: { decidedAt: "asc" } });
    expect(rows.map((r) => [r.decision, r.reasonCode, r.reasonText])).toEqual([
      ["HOLD", "contact_customer", "звъннете след 17:00"],
      ["CANCEL", "suspected_fraud", null],
    ]);
  });

  it("block is refused once a shipment is active at a warehouse (pipeline guard), and rolls back", async () => {
    const o = await checked("#3005");
    await g.db.fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: o.id,
        connectionId: g.connection.id,
        externalId: "TST-3005",
        status: "ACCEPTED",
      },
    });
    await expect(
      decideOrder(g.owner, { orderId: o.id, decision: "block", reasonCode: "suspected_fraud" }),
    ).rejects.toMatchObject({ code: "transition_guard:active_shipment" });
    expect(await g.db.review.count({ where: { orderId: o.id } })).toBe(0);
  });

  it("a stale editor is refused instead of overwriting newer data", async () => {
    const o = await checked("#3006", { missingZip: true });
    await expect(
      editOrderAddress(g.owner, o.id, { values: { zip: "1000" }, version: "2020-01-01T00:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "stale" });
  });

  it("people need orders.review and the order in their companies", async () => {
    const o = await checked("#3007");
    await expect(
      decideOrder({ ...g.owner, role: "VIEWER" }, { orderId: o.id, decision: "approve" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      decideOrder(
        { ...g.owner, role: "OPERATOR", companyScope: ["other-company"] },
        { orderId: o.id, decision: "approve" },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      editOrderAddress({ ...g.owner, role: "OPERATOR", companyScope: ["other-company"] }, o.id, {
        values: { zip: "1" },
        version: o.updatedAt.toISOString(),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      getOrderReview({ ...g.owner, role: "OPERATOR", companyScope: ["other-company"] }, o.id),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("order detail: findings, routing, stock per warehouse, timeline; raw payloads only for admins", async () => {
    const o = await checked("#3008", { missingZip: true });
    const admin = await getOrderReview(g.owner, o.id);
    expect(admin.check?.hardCount).toBeGreaterThan(0);
    expect(admin.check?.routing.explanation.bg).toContain("euShipments test");
    expect(admin.editable).toBe(true);
    expect(admin.decisions).toEqual(expect.arrayContaining(["approve", "hold", "block"]));
    const productId = admin.order.lines[0]!.productId!;
    expect(admin.stock.get(productId)?.get(g.connection.id)?.sellable).toBe(50);
    expect(admin.timeline.map((t) => (t.kind === "status" ? t.to : t.kind))).toEqual([
      "CHECKING",
      "NEEDS_REVIEW",
    ]);
    expect(admin.raw).not.toBeNull();
    const operator = await getOrderReview({ ...g.owner, role: "OPERATOR" }, o.id);
    expect(operator.raw).toBeNull();
    expect(operator.canRaw).toBe(false);
  });

  it("review list: filters by decision and reason, scoped to the member's companies", async () => {
    const all = await listReviews({ accountId: g.accountId, companyScope: null, activeCompanyId: null }, {});
    expect(all.total).toBeGreaterThanOrEqual(4);
    expect(all.rows.every((r) => r.decision)).toBe(true);
    const holds = await listReviews(
      { accountId: g.accountId, companyScope: null, activeCompanyId: null },
      { decision: "HOLD" },
    );
    expect(holds.rows.map((r) => r.order.number)).toEqual(["#3004"]);
    const byReason = await listReviews(
      { accountId: g.accountId, companyScope: null, activeCompanyId: null },
      { reasonCode: "address_fixed" },
    );
    expect(byReason.rows[0]?.changes).toHaveLength(1);
    const other = await listReviews(
      { accountId: g.accountId, companyScope: ["other-company"], activeCompanyId: null },
      {},
    );
    expect(other.total).toBe(0);
  });

  it("reason codes: defaults until the first change, then stored; deactivated codes are refused", async () => {
    const g2 = await euTestGroup("reasons");
    expect((await listReasonCodes(g2.accountId)).map((c) => c.code)).toEqual(
      DEFAULT_REASON_CODES.map((c) => c.code),
    );
    expect(await g2.db.reviewReasonCode.count()).toBe(0);
    await expect(
      saveReasonCode(
        { ...g2.owner, role: "OPERATOR" },
        { code: "x_y", labelBg: "Х", labelEn: "X", decisions: ["hold"] },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await saveReasonCode(g2.owner, {
      code: "Courier_Area",
      labelBg: "Извън зона",
      labelEn: "Out of area",
      decisions: ["hold", "block"],
    });
    expect(await g2.db.reviewReasonCode.count()).toBe(DEFAULT_REASON_CODES.length + 1);
    await setReasonCodeActive(g2.owner, "contact_customer", false);
    const active = await listReasonCodes(g2.accountId);
    expect(active.map((c) => c.code)).toContain("courier_area");
    expect(active.map((c) => c.code)).not.toContain("contact_customer");
    await expect(setReasonCodeActive(g2.owner, "other", false)).rejects.toMatchObject({
      code: "reason_other_required",
    });
    // Other groups never see these codes.
    expect((await listReasonCodes(g.accountId)).map((c) => c.code)).not.toContain("courier_area");
  });

  it("a Shopify re-import keeps the operator's corrected address, phone and country", async () => {
    const store = await g.db.store.update({ where: { id: g.store.id }, data: { codGateways: [] } });
    const base = SYNTHETIC_ORDERS[0]!;
    const first = await importShopifyOrder(g.accountId, store, base);
    const o = await g.db.order.findUniqueOrThrow({ where: { id: first.orderId } });
    await g.db.order.update({ where: { id: o.id }, data: { status: "NEEDS_REVIEW" } });
    const fresh = await g.db.order.findUniqueOrThrow({ where: { id: o.id } });
    await editOrderAddress(g.owner, o.id, {
      values: { address1: "Corrected Street 5", phone: "+359888000111" },
      version: fresh.updatedAt.toISOString(),
    });
    await importShopifyOrder(g.accountId, store, {
      ...base,
      updatedAt: new Date(Date.parse(base.updatedAt) + 60_000).toISOString(),
      note: "changed in Shopify",
    });
    const after = await g.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect((after.shippingAddress as { address1: string }).address1).toBe("Corrected Street 5");
    expect(after.phone).toBe("+359888000111");
    expect(after.note).toBe("changed in Shopify");
  });
});
