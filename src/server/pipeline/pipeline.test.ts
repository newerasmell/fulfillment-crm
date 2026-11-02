import { beforeAll, describe, expect, it } from "vitest";
import type { CrmOrderStatus } from "@/generated/prisma/client";
import { SYNTHETIC_ORDERS } from "@/integrations/shopify/__fixtures__/orders";
import { bootstrapOwner } from "@/server/auth/users";
import { accountDb, systemDb } from "@/server/db/client";
import { importShopifyOrder } from "@/server/shopify/orders";
import {
  allowedTransitions,
  isAllowed,
  nextSteps,
  RULES,
  TERMINAL,
  transitionOrder,
  TransitionError,
  type PipelineActor,
  type TransitionCause,
} from "./index";

// Synthetic data only.
const ALL_STATUSES: CrmOrderStatus[] = [
  "IMPORTED",
  "CHECKING",
  "NEEDS_REVIEW",
  "READY",
  "APPROVED",
  "QUEUED",
  "SUBMITTING",
  "SUBMIT_FAILED",
  "ACCEPTED",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
  "COD_PAID",
  "RETURNING",
  "RETURN_RECEIVED",
  "EXCEPTION",
  "ON_HOLD",
  "BLOCKED",
  "CANCELLED",
  "UNKNOWN",
  "FULFILLED_EXTERNALLY",
];
const CAUSES = [...new Set(RULES.map((r) => r.cause))] as TransitionCause[];

let g: {
  accountId: string;
  userId: string;
  companyId: string;
  storeId: string;
  connectionId: string;
};
let n = 0;

beforeAll(async () => {
  const r = await bootstrapOwner({
    email: `pipeline-${Date.now()}@example.com`,
    name: "O",
    accountName: "Pipeline test",
    password: "correct horse battery staple",
  });
  const accountId = r.account.id;
  const company = await systemDb().company.findFirstOrThrow({ where: { accountId } });
  const db = accountDb(accountId);
  const store = await db.store.create({
    data: {
      accountId,
      companyId: company.id,
      domain: `p-${Date.now()}.example`,
      code: "PIP",
      name: "S",
      currency: "EUR",
    },
  });
  const connection = await db.fulfillmentConnection.create({
    data: { accountId, companyId: company.id, type: "FHB_V3", name: "FHB test" },
  });
  g = { accountId, userId: r.user.id, companyId: company.id, storeId: store.id, connectionId: connection.id };
});

async function orderIn(status: CrmOrderStatus, tags: string[] = []) {
  return accountDb(g.accountId).order.create({
    data: {
      accountId: g.accountId,
      companyId: g.companyId,
      source: "MANUAL",
      storeId: g.storeId,
      number: `P-${++n}`,
      status,
      currency: "EUR",
      subtotal: "10.00",
      total: "10.00",
      paymentMethod: "PREPAID",
      placedAt: new Date(),
      tags,
    },
  });
}

/** A passed pre-flight check (the approve guard needs one). */
const cleanCheck = (orderId: string, hardCount = 0) =>
  accountDb(g.accountId).orderCheck.create({
    data: { accountId: g.accountId, orderId, routing: {}, hardCount },
  });

const actorOf = (kind: "user" | "system" | "ai"): PipelineActor =>
  kind === "user" ? { kind, userId: g.userId } : kind === "ai" ? { kind, level: "L2" } : { kind };

describe("rule table (pure)", () => {
  it("uses only real statuses and leaves terminal states alone", () => {
    for (const t of allowedTransitions()) {
      expect(ALL_STATUSES).toContain(t.from);
      expect(ALL_STATUSES).toContain(t.to);
      expect(t.from).not.toBe(t.to);
      expect(TERMINAL.has(t.from), `${t.cause}: ${t.from} → ${t.to}`).toBe(false);
    }
  });

  it("forbidden samples", () => {
    const no: [TransitionCause, CrmOrderStatus, CrmOrderStatus, "user" | "system" | "ai"][] = [
      ["vendor", "DELIVERED", "SHIPPED", "system"], // never backwards
      ["vendor", "ON_HOLD", "ACCEPTED", "system"], // operator state is never overwritten by a vendor
      ["vendor", "CANCELLED", "SHIPPED", "system"],
      ["vendor", "IMPORTED", "SHIPPED", "system"], // nothing was sent yet
      ["vendor", "SHIPPED", "COD_PAID", "system"], // COD only after delivery
      ["vendor", "RETURN_RECEIVED", "DELIVERED", "system"],
      ["cancel", "SHIPPED", "CANCELLED", "user"], // never cancel a shipped order in the CRM
      ["cancel", "QUEUED", "CANCELLED", "user"],
      ["cancel", "READY", "CANCELLED", "ai"], // AI never cancels
      ["cancel", "READY", "CANCELLED", "system"],
      ["approve", "READY", "APPROVED", "system"], // approval is a person or an AI policy
      ["approve", "IMPORTED", "APPROVED", "user"], // unchecked
      ["approve", "ON_HOLD", "APPROVED", "user"],
      ["hold", "READY", "ON_HOLD", "ai"],
      ["hold", "QUEUED", "ON_HOLD", "user"], // already in the outbox
      ["release", "CANCELLED", "IMPORTED", "user"],
      ["shopify_cancelled", "APPROVED", "CANCELLED", "system"], // after approval it becomes a task
      ["shopify_fulfilled", "QUEUED", "FULFILLED_EXTERNALLY", "system"],
      ["queue", "NEEDS_REVIEW", "QUEUED", "user"],
      ["queue", "IMPORTED", "QUEUED", "user"],
      ["check_result", "IMPORTED", "READY", "system"],
      ["check_start", "QUEUED", "CHECKING", "system"],
      ["submit_failed", "ACCEPTED", "SUBMIT_FAILED", "system"],
    ];
    for (const [cause, from, to, actor] of no)
      expect(isAllowed(cause, from, to, actor), `${cause} ${from}→${to}`).toBe(false);
    for (const from of ["CANCELLED", "FULFILLED_EXTERNALLY", "COD_PAID", "RETURN_RECEIVED"] as const)
      for (const to of ALL_STATUSES)
        for (const cause of CAUSES)
          for (const a of ["user", "system", "ai"] as const)
            expect(isAllowed(cause, from, to, a)).toBe(false);
  });

  it("nextSteps lists what an operator may do", () => {
    const steps = nextSteps("READY", "user").map((s) => `${s.cause}:${s.to}`);
    expect(steps).toEqual(
      expect.arrayContaining([
        "approve:APPROVED",
        "hold:ON_HOLD",
        "cancel:CANCELLED",
        "check_start:CHECKING",
      ]),
    );
    expect(steps).not.toContain("vendor:SHIPPED");
  });
});

describe("every allowed transition", () => {
  it.each(allowedTransitions().map((t) => [`${t.cause}: ${t.from} → ${t.to}`, t] as const))(
    "%s",
    async (_name, t) => {
      const order = await orderIn(t.from);
      if (t.cause === "approve") await cleanCheck(order.id);
      const kind = t.actors[0]!;
      const r = await transitionOrder(g.accountId, {
        orderId: order.id,
        to: t.to,
        cause: t.cause,
        actor: actorOf(kind),
        source: "test",
        reason: "because",
      });
      expect(r).toMatchObject({ changed: true, from: t.from, to: t.to });
      const db = accountDb(g.accountId);
      expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(t.to);
      const events = await db.orderEvent.findMany({ where: { orderId: order.id } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        fromStatus: t.from,
        toStatus: t.to,
        cause: t.cause,
        actorType: kind,
        source: "test",
        reason: "because",
      });
      const audits = await db.auditLog.count({ where: { action: "order.status", entityId: order.id } });
      expect(audits).toBe(kind === "user" ? 1 : 0);
    },
  );
});

describe("refusals and guards", () => {
  const user = () => actorOf("user");

  it("strict mode throws, follow mode is a silent no-op, and nothing is recorded", async () => {
    const shipped = await orderIn("SHIPPED");
    await expect(
      transitionOrder(g.accountId, { orderId: shipped.id, to: "CANCELLED", cause: "cancel", actor: user() }),
    ).rejects.toMatchObject({ code: "transition_not_allowed" });
    const delivered = await orderIn("DELIVERED");
    const r = await transitionOrder(g.accountId, {
      orderId: delivered.id,
      to: "SHIPPED",
      cause: "vendor",
      actor: { kind: "system" },
    });
    expect(r).toMatchObject({ changed: false, reason: "not_allowed", from: "DELIVERED" });
    const db = accountDb(g.accountId);
    expect((await db.order.findUniqueOrThrow({ where: { id: delivered.id } })).status).toBe("DELIVERED");
    expect(await db.orderEvent.count({ where: { orderId: { in: [shipped.id, delivered.id] } } })).toBe(0);
  });

  it("same status is a no-op without an event", async () => {
    const o = await orderIn("SHIPPED");
    const r = await transitionOrder(g.accountId, {
      orderId: o.id,
      to: "SHIPPED",
      cause: "vendor",
      actor: { kind: "system" },
    });
    expect(r).toMatchObject({ changed: false, reason: "same" });
    expect(await accountDb(g.accountId).orderEvent.count({ where: { orderId: o.id } })).toBe(0);
  });

  it("approval needs a check without hard findings", async () => {
    const o = await orderIn("NEEDS_REVIEW");
    const approve = () =>
      transitionOrder(g.accountId, { orderId: o.id, to: "APPROVED", cause: "approve", actor: user() });
    await expect(approve()).rejects.toMatchObject({ code: "transition_guard:no_check" });
    await cleanCheck(o.id, 2);
    await expect(approve()).rejects.toMatchObject({ code: "transition_guard:hard_findings" });
    await accountDb(g.accountId).orderCheck.updateMany({ where: { orderId: o.id }, data: { hardCount: 0 } });
    await expect(approve()).resolves.toMatchObject({ changed: true });
  });

  it("AI approval needs an L2 policy; AI can never cancel", async () => {
    const o = await orderIn("READY");
    await cleanCheck(o.id);
    await expect(
      transitionOrder(g.accountId, {
        orderId: o.id,
        to: "APPROVED",
        cause: "approve",
        actor: { kind: "ai", level: "L1" },
      }),
    ).rejects.toMatchObject({ code: "transition_guard:ai_policy_not_l2" });
    await expect(
      transitionOrder(g.accountId, {
        orderId: o.id,
        to: "CANCELLED",
        cause: "cancel",
        actor: { kind: "ai", level: "L2" },
      }),
    ).rejects.toBeInstanceOf(TransitionError);
  });

  it("cancel is refused while a shipment is active at a warehouse, allowed after it failed", async () => {
    const o = await orderIn("SUBMIT_FAILED");
    const db = accountDb(g.accountId);
    const f = await db.fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: o.id,
        connectionId: g.connectionId,
        externalId: `X-${o.id}`,
        status: "QUEUED",
      },
    });
    await expect(
      transitionOrder(g.accountId, { orderId: o.id, to: "CANCELLED", cause: "cancel", actor: user() }),
    ).rejects.toMatchObject({ code: "transition_guard:active_shipment" });
    await db.fulfillment.update({ where: { id: f.id }, data: { status: "SUBMIT_FAILED" } });
    await expect(
      transitionOrder(g.accountId, { orderId: o.id, to: "CANCELLED", cause: "cancel", actor: user() }),
    ).resolves.toMatchObject({ changed: true });
  });

  it("a held Shopify test order cannot be released", async () => {
    const o = await orderIn("ON_HOLD", ["shopify-test"]);
    await expect(
      transitionOrder(g.accountId, { orderId: o.id, to: "IMPORTED", cause: "release", actor: user() }),
    ).rejects.toMatchObject({ code: "transition_guard:shopify_test_order" });
  });

  it("onlyFrom narrows the table for one call", async () => {
    const o = await orderIn("UNKNOWN");
    const r = await transitionOrder(g.accountId, {
      orderId: o.id,
      to: "ACCEPTED",
      cause: "vendor",
      actor: { kind: "system" },
      onlyFrom: ["APPROVED", "QUEUED", "SUBMITTING", "SUBMIT_FAILED"],
    });
    expect(r).toMatchObject({ changed: false, reason: "not_allowed" });
  });

  it("an order of another group is not found", async () => {
    const o = await orderIn("READY");
    const other = await systemDb().account.create({ data: { name: "Other group" } });
    await expect(
      transitionOrder(other.id, { orderId: o.id, to: "APPROVED", cause: "approve", actor: user() }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("Shopify import goes through the pipeline", () => {
  it("records the initial status and a cancel in Shopify before approval", async () => {
    const store = { id: g.storeId, companyId: g.companyId, codGateways: [], skuPrefix: null };
    const base = SYNTHETIC_ORDERS.find(
      (o) => !o.cancelledAt && o.displayFulfillmentStatus !== "FULFILLED" && !o.test,
    )!;
    const o = { ...base, id: `gid://shopify/Order/pipeline-${Date.now()}` };
    const { orderId } = await importShopifyOrder(g.accountId, store, o);
    const later = new Date(new Date(o.updatedAt).getTime() + 60_000).toISOString();
    await importShopifyOrder(g.accountId, store, { ...o, updatedAt: later, cancelledAt: later });
    const events = await accountDb(g.accountId).orderEvent.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => [e.fromStatus, e.toStatus, e.cause, e.source])).toEqual([
      [null, "IMPORTED", "created", "shopify.import"],
      ["IMPORTED", "CANCELLED", "shopify_cancelled", "shopify.import"],
    ]);
  });
});
