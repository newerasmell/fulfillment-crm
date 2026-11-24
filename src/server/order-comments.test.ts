import { describe, expect, it } from "vitest";
import { systemDb } from "@/server/db/client";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import { listOrders } from "@/server/orders";
import { addOrderComment, latestCommentOf, listOrderComments } from "./order-comments";

// Comments on an order (owner request 2026-11-24). Synthetic data only.
describe("order comments", () => {
  it("adds and lists comments with author and time, within the member's reach; the list shows the latest", async () => {
    const g = await euTestGroup("comments");
    const { order } = await euTestOrder(g, { number: "#CM-1" });
    const me = { ...g.owner, author: "Synthetic Operator" };
    await addOrderComment(me, order.id, "  Called the customer, no answer  ");
    await addOrderComment(me, order.id, "Second try tomorrow");
    const list = await listOrderComments(g.owner, order.id);
    expect(list.map((c) => c.body)).toEqual(["Called the customer, no answer", "Second try tomorrow"]);
    expect(list[0]).toMatchObject({ author: "Synthetic Operator" });
    expect((await latestCommentOf(g.accountId, [order.id])).get(order.id)?.body).toBe("Second try tomorrow");
    const rows = (
      await listOrders({ accountId: g.accountId, companyScope: null, activeCompanyId: null }, { tab: "all" })
    ).rows;
    expect(rows.find((r) => r.id === order.id)?.lastComment?.body).toBe("Second try tomorrow");
    expect(
      await systemDb().auditLog.count({
        where: { accountId: g.accountId, action: "order.comment", entityId: order.id },
      }),
    ).toBe(2);

    // Refused: too short, a viewer, another group, a member of another company.
    await expect(addOrderComment(me, order.id, " x ")).rejects.toThrow();
    await expect(addOrderComment(me, order.id, "x".repeat(2001))).rejects.toThrow();
    await expect(addOrderComment({ ...me, role: "VIEWER" }, order.id, "Viewer note")).rejects.toThrow();
    const stranger = await euTestGroup("comments-other");
    await expect(
      addOrderComment({ ...stranger.owner, author: "S" }, order.id, "From elsewhere"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(listOrderComments(stranger.owner, order.id)).rejects.toMatchObject({ code: "not_found" });
    const other = await systemDb().company.create({ data: { accountId: g.accountId, name: "Elsewhere" } });
    await expect(
      addOrderComment({ ...me, role: "OPERATOR", companyScope: [other.id] }, order.id, "Not mine"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      listOrderComments({ ...g.owner, role: "OPERATOR", companyScope: [other.id] }, order.id),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await systemDb().orderComment.count({ where: { orderId: order.id } })).toBe(2);
  });
});
