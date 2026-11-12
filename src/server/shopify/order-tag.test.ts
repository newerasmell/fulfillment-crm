import { beforeAll, describe, expect, it } from "vitest";
import { SYNTHETIC_ORDERS } from "@/integrations/shopify/__fixtures__/orders";
import type { ShopifyOrder } from "@/integrations/shopify/orders";
import { ForbiddenError } from "@/server/auth/rbac";
import { euTestGroup } from "@/server/eushipments/test-fixtures";
import { checkOrder } from "@/server/checks";
import { dashboardSummary, listOrders, orderTabCounts } from "@/server/orders";
import { transitionOrder } from "@/server/pipeline";
import { importShopifyOrder } from "./orders";
import { hasStoreTag, setStoreOrderTag } from "./order-tag";

// Synthetic data only; nothing calls Shopify or a warehouse.

describe("store tag match (pure)", () => {
  it("case-insensitive, trimmed, whole tag only", () => {
    expect(hasStoreTag(["confirmed"], "Confirmed")).toBe(true);
    expect(hasStoreTag([" CONFIRMED "], "confirmed")).toBe(true);
    expect(hasStoreTag(["Unconfirmed", "confirmed-later"], "Confirmed")).toBe(false);
    expect(hasStoreTag([], "Confirmed")).toBe(false);
    expect(hasStoreTag(["x"], " ")).toBe(false);
  });
});

describe("Само поръчки с таг (database)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  let n = 0;
  const base = SYNTHETIC_ORDERS[1]!;
  const order = (tags: string[], i: number, minutes = 0): ShopifyOrder => ({
    ...base,
    id: `gid://shopify/Order/77${i}`,
    name: `#T-${i}`,
    tags,
    updatedAt: new Date(Date.parse(base.updatedAt) + minutes * 60_000).toISOString(),
  });
  const imp = async (o: ShopifyOrder) => {
    const store = await g.db.store.findUniqueOrThrow({ where: { id: g.store.id } });
    return (await importShopifyOrder(g.accountId, store, o)).orderId;
  };
  const status = async (id: string) => (await g.db.order.findUniqueOrThrow({ where: { id } })).status;
  const ctx = () => ({ accountId: g.accountId, companyScope: null, activeCompanyId: null });

  beforeAll(async () => {
    g = await euTestGroup("store-tag");
  });

  it("without a tag required every order enters as before", async () => {
    const id = await imp(order([], ++n));
    expect(await status(id)).toBe("IMPORTED");
  });

  it("set aside without the tag, out of every tab but Чака таг; enters review when tagged, back when untagged", async () => {
    await setStoreOrderTag(g.owner, g.store.id, { tag: "Confirmed" });
    const i = ++n;
    const id = await imp(order(["vip"], i));
    expect(await status(id)).toBe("AWAITING_TAG");
    const counts = await orderTabCounts(ctx(), {});
    expect(counts.awaitingTag).toBeGreaterThanOrEqual(1);
    for (const tab of ["review", "ready", "blocked", "transit", "all"] as const)
      expect((await listOrders(ctx(), { tab })).rows.map((r) => r.id)).not.toContain(id);
    expect((await listOrders(ctx(), { tab: "awaitingTag" })).rows.map((r) => r.id)).toContain(id);
    // No check runs while it waits.
    await expect(
      transitionOrder(g.accountId, {
        orderId: id,
        to: "CHECKING",
        cause: "check_start",
        actor: { kind: "system" },
        mode: "strict",
      }),
    ).rejects.toThrow();

    await imp(order(["vip", "CONFIRMED"], i, 1)); // any case
    expect(await status(id)).toBe("IMPORTED");
    await imp(order(["vip"], i, 2));
    expect(await status(id)).toBe("AWAITING_TAG");
  });

  it("saving the tag re-sorts only orders not sent yet; clearing it brings them back", async () => {
    await setStoreOrderTag(g.owner, g.store.id, { tag: null });
    const review = await imp(order([], ++n));
    const tagged = await imp(order(["confirmed"], ++n));
    const queued = await imp(order([], ++n));
    await g.db.order.update({ where: { id: review }, data: { status: "NEEDS_REVIEW" } });
    await g.db.order.update({ where: { id: queued }, data: { status: "QUEUED" } });

    await expect(
      setStoreOrderTag({ ...g.owner, role: "OPERATOR" }, g.store.id, { tag: "Confirmed" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      setStoreOrderTag({ ...g.owner, role: "ADMIN", companyScope: ["other"] }, g.store.id, {
        tag: "Confirmed",
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    const r = await setStoreOrderTag(g.owner, g.store.id, { tag: "  confirmed " });
    expect(r.setAside).toBeGreaterThanOrEqual(1);
    expect(await status(review)).toBe("AWAITING_TAG");
    expect(await status(tagged)).toBe("IMPORTED");
    expect(await status(queued)).toBe("QUEUED"); // already with a warehouse: untouched
    expect(
      await g.db.auditLog.count({ where: { action: "store.order_tag", entityId: g.store.id } }),
    ).toBeGreaterThan(0);

    const cleared = await setStoreOrderTag(g.owner, g.store.id, { tag: "" });
    expect(cleared.released).toBeGreaterThanOrEqual(1);
    expect(await status(review)).toBe("IMPORTED");
  });

  it("an approved order that loses the tag is set aside; one already sent keeps going and opens a task", async () => {
    await setStoreOrderTag(g.owner, g.store.id, { tag: "Confirmed" });
    const a = ++n;
    const approved = await imp(order(["Confirmed"], a));
    await g.db.order.update({ where: { id: approved }, data: { status: "APPROVED" } });
    await imp(order([], a, 1));
    expect(await status(approved)).toBe("AWAITING_TAG");

    const s = ++n;
    const sent = await imp(order(["Confirmed"], s));
    await g.db.order.update({ where: { id: sent }, data: { status: "ACCEPTED" } });
    await imp(order([], s, 1));
    expect(await status(sent)).toBe("ACCEPTED");
    expect(
      await g.db.alert.count({ where: { kind: "shopify_tag_removed_after_send", entityId: sent } }),
    ).toBe(1);
    // The tag comes back (an app rewrote the tags for a moment): the task closes by itself.
    await imp(order(["Confirmed", "tracking"], s, 2));
    expect(
      await g.db.alert.findFirstOrThrow({
        where: { kind: "shopify_tag_removed_after_send", entityId: sent },
      }),
    ).toMatchObject({ status: "RESOLVED" });
    expect(
      await g.db.alertNote.count({
        where: { action: "auto_resolve", alert: { entityId: sent, kind: "shopify_tag_removed_after_send" } },
      }),
    ).toBe(1);
    expect(await status(sent)).toBe("ACCEPTED");
    // Lost again later: exactly one new task.
    await imp(order(["tracking"], s, 3));
    expect(
      await g.db.alert.count({
        where: { kind: "shopify_tag_removed_after_send", entityId: sent, status: { not: "RESOLVED" } },
      }),
    ).toBe(1);
  });

  it("backstop: without the tag nothing approves, queues, releases or restarts it; it is never checked", async () => {
    await setStoreOrderTag(g.owner, g.store.id, { tag: "Confirmed" });
    const user = { kind: "user" as const, userId: g.owner.userId };
    const held = await imp(order([], ++n));
    await g.db.order.update({ where: { id: held }, data: { status: "ON_HOLD" } });
    await expect(
      transitionOrder(g.accountId, { orderId: held, to: "IMPORTED", cause: "release", actor: user }),
    ).rejects.toMatchObject({ guard: "store_tag_missing" });
    await g.db.order.update({ where: { id: held }, data: { status: "BLOCKED" } });
    await expect(
      transitionOrder(g.accountId, { orderId: held, to: "IMPORTED", cause: "restart", actor: user }),
    ).rejects.toMatchObject({ guard: "store_tag_missing" });
    await g.db.order.update({ where: { id: held }, data: { status: "APPROVED" } });
    await expect(
      transitionOrder(g.accountId, { orderId: held, to: "QUEUED", cause: "queue", actor: user }),
    ).rejects.toMatchObject({ guard: "store_tag_missing" });

    const waiting = await imp(order([], ++n));
    expect(await status(waiting)).toBe("AWAITING_TAG");
    await expect(checkOrder(g.accountId, waiting, { actor: { kind: "system" } })).rejects.toMatchObject({
      code: "awaiting_tag",
    });
    expect(await g.db.orderCheck.count({ where: { orderId: waiting } })).toBe(0);
    // Not on Начало either.
    const dash = await dashboardSummary(ctx());
    expect(dash.recent.map((r) => r.id)).not.toContain(waiting);
  });

  it("re-sort: a refused submit is set aside; an order with a live shipment never is", async () => {
    await setStoreOrderTag(g.owner, g.store.id, { tag: null });
    const failed = await imp(order([], ++n));
    await g.db.order.update({ where: { id: failed }, data: { status: "SUBMIT_FAILED" } });
    const live = await imp(order([], ++n));
    await g.db.order.update({ where: { id: live }, data: { status: "APPROVED" } });
    await g.db.fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: live,
        connectionId: g.connection.id,
        externalId: `TAG-LIVE-${n}`,
        status: "ACCEPTED",
      },
    });
    await setStoreOrderTag(g.owner, g.store.id, { tag: "Confirmed" });
    expect(await status(failed)).toBe("AWAITING_TAG");
    expect(await status(live)).toBe("APPROVED");
  });

  it("an approved order that loses the tag takes Shopify's new data; a removed tag after sending opens one task", async () => {
    await setStoreOrderTag(g.owner, g.store.id, { tag: "Confirmed" });
    const a = ++n;
    const id = await imp(order(["Confirmed"], a));
    await g.db.order.update({ where: { id }, data: { status: "APPROVED" } });
    await imp({
      ...order([], a, 1),
      totalPriceSet: { shopMoney: { amount: "99.00", currencyCode: "EUR" } },
    } as ShopifyOrder);
    const o = await g.db.order.findUniqueOrThrow({ where: { id } });
    expect(o.status).toBe("AWAITING_TAG");
    expect(o.total.toString()).toBe("99");

    const s = ++n;
    const sent = await imp(order(["Confirmed"], s));
    await g.db.order.update({ where: { id: sent }, data: { status: "SHIPPED" } });
    await imp(order([], s, 1));
    await imp(order(["other"], s, 2));
    expect(
      await g.db.alert.count({ where: { kind: "shopify_tag_removed_after_send", entityId: sent } }),
    ).toBe(1);
  });

  it("another group's member cannot change this store's tag", async () => {
    const other = await euTestGroup("store-tag-other");
    await expect(setStoreOrderTag(other.owner, g.store.id, { tag: "X" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
