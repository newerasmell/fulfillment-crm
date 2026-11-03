import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/auth/rbac";
import { checkOrder } from "@/server/checks";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import { importShopifyOrder } from "@/server/shopify/orders";
import { SYNTHETIC_ORDERS } from "@/integrations/shopify/__fixtures__/orders";
import { transitionOrder } from "@/server/pipeline";
import {
  AddressEdit,
  BLOCKED_TASK_KIND,
  DEFAULT_REASON_CODES,
  decideOrder,
  diffValues,
  editOrderAddress,
  editorValues,
  getOrderRawPayload,
  getOrderReview,
  listReasonCodes,
  listReviews,
  MAX_REVIEW_MS,
  mergeDiff,
  previewAddress,
  redactSecrets,
  releaseOrder,
  restartOrder,
  saveReasonCode,
  setReasonCodeActive,
  SUPERSEDED_REASON,
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

    // The Shopify original as it was before the correction (the fixture has no zip there either).
    await g.db.order.update({
      where: { id: o.id },
      data: { shippingAddressOriginal: { ...(o.shippingAddress as object), zip: null } },
    });
    const beforeEdit = await g.db.order.findUniqueOrThrow({ where: { id: o.id } });
    const r = await editOrderAddress(g.owner, o.id, {
      values: { zip: "1000" },
      version: beforeEdit.updatedAt.toISOString(),
    });
    expect(r).toMatchObject({ status: "READY", hardCount: 0 });
    expect(r.changed).toEqual([{ field: "shippingAddress.zip", from: null, to: "1000", via: "manual" }]);
    const after = await g.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect((after.shippingAddress as { zip: string }).zip).toBe("1000");
    expect(after.shippingAddressOriginal).toEqual(beforeEdit.shippingAddressOriginal); // original untouched
    expect((after.shippingAddressOriginal as { zip: string | null }).zip).toBeNull();
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
    expect(await g.db.alert.count({ where: { entityId: o.id, kind: BLOCKED_TASK_KIND } })).toBe(0);
    const b = await decideOrder(g.owner, { orderId: o.id, decision: "block", reasonCode: "suspected_fraud" });
    expect(b).toMatchObject({ decision: "CANCEL", status: "CANCELLED" });
    // Still open in Shopify: an operator task is opened in the same transaction.
    const task = await g.db.alert.findFirstOrThrow({ where: { entityId: o.id, kind: BLOCKED_TASK_KIND } });
    expect(task).toMatchObject({ isTask: true, entityType: "Order", status: "OPEN" });
    expect(task.title).toContain("#3004");
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
    expect(await g.db.alert.count({ where: { entityId: o.id, kind: BLOCKED_TASK_KIND } })).toBe(0);
  });

  it("a stale editor is refused instead of overwriting newer data", async () => {
    const o = await checked("#3006", { missingZip: true });
    await expect(
      editOrderAddress(g.owner, o.id, { values: { zip: "1000" }, version: "2020-01-01T00:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "stale" });
    // A real concurrent edit: two editors opened at the same version; the second save is refused.
    const version = o.updatedAt.toISOString();
    await editOrderAddress(g.owner, o.id, { values: { zip: "1000" }, version });
    await expect(
      editOrderAddress({ ...g.owner, userId: "second-editor" }, o.id, { values: { zip: "2000" }, version }),
    ).rejects.toMatchObject({ code: "stale" });
    const after = await g.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect((after.shippingAddress as { zip: string }).zip).toBe("1000");
  });

  it("duplicate submit: the same edit or decision at the same moment is applied exactly once", async () => {
    const o = await checked("#3020", { missingZip: true });
    const version = o.updatedAt.toISOString();
    const edits = await Promise.allSettled([
      editOrderAddress(g.owner, o.id, { values: { zip: "1000" }, version }),
      editOrderAddress(g.owner, o.id, { values: { zip: "1000" }, version }),
    ]);
    expect(edits.filter((e) => e.status === "fulfilled")).toHaveLength(1);
    expect(edits.find((e) => e.status === "rejected")).toMatchObject({ reason: { code: "stale" } });
    expect(await g.db.auditLog.count({ where: { entityId: o.id, action: "order.address_edited" } })).toBe(1);
    const decisions = await Promise.allSettled([
      decideOrder(g.owner, { orderId: o.id, decision: "approve" }),
      decideOrder(g.owner, { orderId: o.id, decision: "approve" }),
    ]);
    expect(decisions.filter((d) => d.status === "fulfilled")).toHaveLength(1);
    expect(await g.db.review.count({ where: { orderId: o.id, decision: { not: null } } })).toBe(1);
    expect(await g.db.orderEvent.count({ where: { orderId: o.id, cause: "approve" } })).toBe(1);
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
    expect(admin.canRaw).toBe(true);
    // Raw payloads are not part of the detail at all; they load per section, for admins only.
    expect(admin).not.toHaveProperty("raw");
    expect(await getOrderRawPayload(g.owner, o.id, "original")).not.toBeNull();
    const operator = await getOrderReview({ ...g.owner, role: "OPERATOR" }, o.id);
    expect(operator.canRaw).toBe(false);
    await expect(
      getOrderRawPayload({ ...g.owner, role: "OPERATOR" }, o.id, "shopify"),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      getOrderRawPayload({ ...g.owner, companyScope: ["other-company"] }, o.id, "shopify"),
    ).rejects.toMatchObject({ code: "not_found" });
    // Payload preview: the euShipments body that would be sent, built by the queue function's pre-flight.
    expect(admin.payload).toMatchObject({
      connectionType: "EUSHIPMENTS",
      body: {
        senderId: 333,
        recipient: { cityName: "Sofia", zipCode: null },
        awb: { referenceNumber: expect.any(String) },
      },
    });
    expect(await g.db.outboundRequest.count({ where: { connectionId: g.connection.id } })).toBe(0);
  });

  it("raw outbox payloads: callback tokens in URLs are redacted", async () => {
    expect(
      redactSecrets({
        body: {
          notification: { sent: "https://crm.example.test/api/webhooks/fhb/c1/order/f1/sent/SECRETTOKEN" },
          note: "keep me",
        },
        list: ["https://x.example/api/webhooks/fhb/c1/stock/TOK2", 3],
      }),
    ).toEqual({
      body: {
        notification: { sent: "https://crm.example.test/api/webhooks/[redacted]" },
        note: "keep me",
      },
      list: ["https://x.example/api/webhooks/[redacted]", 3],
    });
    const o = await checked("#3021");
    const f = await g.db.fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: o.id,
        connectionId: g.connection.id,
        externalId: "TST-3021",
        status: "QUEUED",
      },
    });
    await g.db.outboundRequest.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        operation: "fhb.order.create",
        idempotencyKey: "test:3021",
        fulfillmentId: f.id,
        payload: { body: { notification: { sent: "https://crm.example.test/api/webhooks/fhb/a/b/SECRET" } } },
      },
    });
    const rows = JSON.stringify(await getOrderRawPayload(g.owner, o.id, "outbox"));
    expect(rows).toContain("fhb.order.create");
    expect(rows).not.toContain("SECRET");
    // Still READY: previewed. Once queued (sent), the outbox shows what was sent instead.
    expect((await getOrderReview(g.owner, o.id)).payload).not.toBeNull();
    await g.db.order.update({ where: { id: o.id }, data: { status: "QUEUED" } });
    expect((await getOrderReview(g.owner, o.id)).payload).toBeNull();
  });

  it("review list: filters by decision and reason, scoped to the member's companies", async () => {
    const all = await listReviews(
      { accountId: g.accountId, role: "OWNER" as const, companyScope: null, activeCompanyId: null },
      {},
    );
    expect(all.total).toBeGreaterThanOrEqual(4);
    expect(all.rows.every((r) => r.decision)).toBe(true);
    const holds = await listReviews(
      { accountId: g.accountId, role: "OWNER" as const, companyScope: null, activeCompanyId: null },
      { decision: "HOLD" },
    );
    expect(holds.rows.map((r) => r.order.number)).toEqual(["#3004"]);
    const byReason = await listReviews(
      { accountId: g.accountId, role: "OWNER" as const, companyScope: null, activeCompanyId: null },
      { reasonCode: "address_fixed" },
    );
    expect(byReason.rows[0]?.changes).toHaveLength(1);
    const other = await listReviews(
      {
        accountId: g.accountId,
        role: "OWNER" as const,
        companyScope: ["other-company"],
        activeCompanyId: null,
      },
      {},
    );
    expect(other.total).toBe(0);
    // The diffs hold phones and addresses: listReviews checks reviews.read itself.
    await expect(
      listReviews({ accountId: g.accountId, role: "VIEWER", companyScope: null, activeCompanyId: null }, {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Superseded (merged) sessions are never listed as decisions.
    expect(all.rows.every((r) => r.reasonCode !== SUPERSEDED_REASON)).toBe(true);
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
    expect(fresh.countryCode).toBe("BG");
    await editOrderAddress(g.owner, o.id, {
      values: { address1: "Corrected Street 5", phone: "+359888000111", countryCode: "RO" },
      version: fresh.updatedAt.toISOString(),
    });
    expect((await g.db.order.findUniqueOrThrow({ where: { id: o.id } })).countryCode).toBe("RO");
    await importShopifyOrder(g.accountId, store, {
      ...base,
      updatedAt: new Date(Date.parse(base.updatedAt) + 60_000).toISOString(),
      note: "changed in Shopify",
    });
    const after = await g.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect((after.shippingAddress as { address1: string }).address1).toBe("Corrected Street 5");
    expect(after.phone).toBe("+359888000111");
    expect(after.countryCode).toBe("RO");
    expect((after.shippingAddress as { countryCode: string }).countryCode).toBe("RO");
    expect(after.note).toBe("changed in Shopify");
  });

  it("a phone-only correction that leaves the address identical survives a re-import", async () => {
    const store = await g.db.store.findUniqueOrThrow({ where: { id: g.store.id } });
    const base = SYNTHETIC_ORDERS[0]!;
    const shop = {
      ...base,
      id: "gid://shopify/Order/990001",
      name: "#3101",
      phone: "0888111222",
      shippingAddress: { ...base.shippingAddress!, phone: "+359888111222" },
    };
    const first = await importShopifyOrder(g.accountId, store, shop);
    await g.db.order.update({ where: { id: first.orderId }, data: { status: "NEEDS_REVIEW" } });
    const fresh = await g.db.order.findUniqueOrThrow({ where: { id: first.orderId } });
    expect(fresh.phone).toBe("0888111222");
    const r = await editOrderAddress(g.owner, fresh.id, {
      values: { phone: "+359888111222" },
      version: fresh.updatedAt.toISOString(),
      via: "suggested_fix:order.phone_invalid",
    });
    expect(r.changed).toEqual([
      { field: "phone", from: "0888111222", to: "+359888111222", via: "suggested_fix:order.phone_invalid" },
    ]);
    const edited = await g.db.order.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(edited.shippingAddress).toEqual(fresh.shippingAddress); // byte-identical address
    await importShopifyOrder(g.accountId, store, {
      ...shop,
      updatedAt: new Date(Date.parse(shop.updatedAt) + 60_000).toISOString(),
    });
    expect((await g.db.order.findUniqueOrThrow({ where: { id: fresh.id } })).phone).toBe("+359888111222");

    // An order nobody corrected still follows Shopify's phone.
    const other = { ...shop, id: "gid://shopify/Order/990002", name: "#3102" };
    const o2 = await importShopifyOrder(g.accountId, store, other);
    await importShopifyOrder(g.accountId, store, {
      ...other,
      phone: "0888999000",
      updatedAt: new Date(Date.parse(other.updatedAt) + 60_000).toISOString(),
    });
    expect((await g.db.order.findUniqueOrThrow({ where: { id: o2.orderId } })).phone).toBe("0888999000");
  });

  it("two reviewers: B's decision carries A's correction and closes A's session", async () => {
    const o = await checked("#3030", { missingZip: true });
    const a = g.owner;
    const b = { ...g.owner, userId: "reviewer-b", role: "OPERATOR" as const };
    await editOrderAddress(a, o.id, { values: { zip: "1000" }, version: o.updatedAt.toISOString() });
    const detail = await getOrderReview(b, o.id);
    expect(detail.session?.diff).toHaveLength(1); // B sees the pending correction too
    const d = await decideOrder(b, { orderId: o.id, decision: "approve", reasonCode: "address_fixed" });
    expect(d.decision).toBe("EDIT_AND_APPROVE");
    const review = await g.db.review.findUniqueOrThrow({ where: { id: d.reviewId } });
    expect(review.reviewerId).toBe("reviewer-b");
    expect(review.diff).toEqual([{ field: "shippingAddress.zip", from: null, to: "1000", via: "manual" }]);
    expect((review.findings as { code: string }[]).map((f) => f.code)).toContain("order.address.zip_missing");
    const sessionA = await g.db.review.findFirstOrThrow({ where: { orderId: o.id, reviewerId: a.userId } });
    expect(sessionA).toMatchObject({ decision: null, reasonCode: SUPERSEDED_REASON });
    expect(sessionA.decidedAt).not.toBeNull();
    expect(await g.db.review.count({ where: { orderId: o.id, decision: null, decidedAt: null } })).toBe(0);
  });

  it("a reopened order starts a new review: an earlier cycle's open session is never reused", async () => {
    const o = await checked("#3031");
    expect(o.status).toBe("READY");
    await editOrderAddress(g.owner, o.id, {
      values: { address2: "ap. 7" },
      version: o.updatedAt.toISOString(),
    });
    const stale = await g.db.review.findFirstOrThrow({ where: { orderId: o.id, decision: null } });
    // Approved outside the review screen (e.g. an AI L2 policy), then reopened by a person.
    await transitionOrder(g.accountId, {
      orderId: o.id,
      to: "APPROVED",
      cause: "approve",
      actor: { kind: "user", userId: g.owner.userId },
    });
    await transitionOrder(g.accountId, {
      orderId: o.id,
      to: "NEEDS_REVIEW",
      cause: "reopen",
      actor: { kind: "user", userId: g.owner.userId },
    });
    expect((await getOrderReview(g.owner, o.id)).session).toBeNull();
    const h = await decideOrder(g.owner, { orderId: o.id, decision: "hold", reasonCode: "contact_customer" });
    expect(h.reviewId).not.toBe(stale.id);
    const review = await g.db.review.findUniqueOrThrow({ where: { id: h.reviewId } });
    expect(review).toMatchObject({ decision: "HOLD", diff: [] });
    expect(await g.db.review.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({
      decision: null,
      reasonCode: SUPERSEDED_REASON,
    });
  });

  it("editing: allowed while held, refused once cancelled or after a failed submit", async () => {
    const held = await checked("#3040");
    await decideOrder(g.owner, { orderId: held.id, decision: "hold", reasonCode: "contact_customer" });
    const h = await g.db.order.findUniqueOrThrow({ where: { id: held.id } });
    const r = await editOrderAddress(g.owner, held.id, {
      values: { city: "Plovdiv", countryCode: "BG" },
      version: h.updatedAt.toISOString(),
    });
    expect(r.changed.map((c) => c.field)).toEqual(["shippingAddress.city"]);
    expect(r.status).toBe("ON_HOLD"); // the re-check never releases a hold
    for (const status of ["CANCELLED", "SUBMIT_FAILED"] as const) {
      const o = await checked(`#304${status === "CANCELLED" ? 1 : 2}`);
      const moved = await g.db.order.update({ where: { id: o.id }, data: { status } });
      await expect(
        editOrderAddress(g.owner, o.id, { values: { zip: "1001" }, version: moved.updatedAt.toISOString() }),
      ).rejects.toMatchObject({ code: "not_editable" });
    }
  });

  it("previewAddress: only within the member's companies and with orders.review", async () => {
    const o = await checked("#3050");
    await expect(
      previewAddress({ ...g.owner, role: "OPERATOR", companyScope: ["other-company"] }, o.id, { zip: "1" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(previewAddress({ ...g.owner, role: "VIEWER" }, o.id, { zip: "1" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(
      (
        await previewAddress({ ...g.owner, role: "OPERATOR", companyScope: [g.company.id] }, o.id, {
          zip: "",
        })
      ).findings.map((f) => f.code),
    ).toContain("order.address.zip_missing");
  });

  it("restart: an order the warehouse blocked starts over only when no shipment of it is active", async () => {
    const o = await checked("#3070");
    await g.db.order.update({ where: { id: o.id }, data: { status: "BLOCKED" } });
    const f = await g.db.fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: o.id,
        connectionId: g.connection.id,
        externalId: `R-3070-${o.id}`,
        status: "ACCEPTED",
      },
    });
    await expect(restartOrder(g.owner, o.id)).rejects.toMatchObject({ code: "shipment_active" });
    await expect(restartOrder({ ...g.owner, role: "VIEWER" }, o.id)).rejects.toBeInstanceOf(ForbiddenError);
    await g.db.fulfillment.update({ where: { id: f.id }, data: { status: "CANCELLED" } });
    await restartOrder(g.owner, o.id);
    expect((await g.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("READY");
    expect(await g.db.orderEvent.count({ where: { orderId: o.id, cause: "restart" } })).toBe(1);
    await expect(restartOrder(g.owner, o.id)).rejects.toMatchObject({ code: "transition_not_allowed" });
  });

  it("release: a held order starts over and is re-checked; Shopify test orders and other companies are refused", async () => {
    const o = await checked("#3060");
    await decideOrder(g.owner, { orderId: o.id, decision: "hold", reasonCode: "contact_customer" });
    await expect(releaseOrder({ ...g.owner, role: "VIEWER" }, o.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      releaseOrder({ ...g.owner, role: "OPERATOR", companyScope: ["other-company"] }, o.id),
    ).rejects.toMatchObject({ code: "not_found" });
    const r = await releaseOrder(g.owner, o.id);
    expect(r.hardCount).toBe(0);
    expect((await g.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("READY");
    expect(await g.db.orderEvent.count({ where: { orderId: o.id, cause: "release" } })).toBe(1);
    await expect(releaseOrder(g.owner, o.id)).rejects.toMatchObject({ code: "transition_not_allowed" });

    const t = await checked("#3061");
    await g.db.order.update({ where: { id: t.id }, data: { status: "ON_HOLD", tags: ["shopify-test"] } });
    await expect(releaseOrder(g.owner, t.id)).rejects.toMatchObject({
      code: "transition_guard:shopify_test_order",
    });
    expect((await g.db.order.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("ON_HOLD");
  });
});
