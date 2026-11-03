import { beforeEach, describe, expect, it } from "vitest";
import type { ShopifyClient } from "@/integrations/shopify/client";
import { ShopifyError } from "@/integrations/shopify/errors";
import { ACTIVATE_MUTATION, activationIdempotencyKey } from "@/integrations/shopify/inventory";
import { ForbiddenError } from "@/server/auth/rbac";
import { bootstrapOwner } from "@/server/auth/users";
import { accountDb, systemDb } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";
import {
  activationCandidates,
  createInventoryActivation,
  processInventoryActivation,
  selectActivationCandidates,
  storeActivations,
  sweepInventoryActivations,
  THROTTLE_BACKOFF_MS,
  type StoredActivationRequest,
} from "./activate";
import { planInventoryPush, type PushClients } from "./push";
import { syncStoreInventory } from "./shopify-inventory";

// Synthetic data only; Shopify is mocked (no network).

const LOC_A = "gid://shopify/Location/71"; // stocked (FHB)
const LOC_B = "gid://shopify/Location/72"; // second location (euShipments), nothing stocked yet
const item = (n: number) => `gid://shopify/InventoryItem/${n}`;

describe("candidate selection (pure)", () => {
  const level = (locationGid: string, n: number, tracked = true) => ({
    locationGid,
    inventoryItemGid: item(n),
    tracked,
  });
  it("linked + tracked + known elsewhere + not at the location; one per inventory item", () => {
    const m = selectActivationCandidates(
      [LOC_A, LOC_B],
      [
        { id: "l1", sku: "A", title: "A", productId: "p1", inventoryLevels: [level(LOC_A, 1)] },
        { id: "l2", sku: "B", title: "B", productId: null, inventoryLevels: [level(LOC_A, 2)] },
        { id: "l3", sku: "C", title: "C", productId: "p3", inventoryLevels: [level(LOC_A, 3, false)] },
        { id: "l4", sku: "D", title: "D", productId: "p4", inventoryLevels: [] },
        {
          id: "l5",
          sku: "E",
          title: "E",
          productId: "p5",
          inventoryLevels: [level(LOC_A, 5), level(LOC_B, 5)],
        },
        { id: "l6", sku: "F", title: "F", productId: "p6", inventoryLevels: [level(LOC_B, 6)] },
      ],
    );
    expect(m.get(LOC_B)!.map((c) => c.variantLinkId)).toEqual(["l1"]);
    expect(m.get(LOC_A)!.map((c) => [c.variantLinkId, c.inventoryItemGid])).toEqual([["l6", item(6)]]);
  });
});

async function setup(label: string) {
  const r = await bootstrapOwner({
    email: `act-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    name: "O",
    accountName: `Activation test ${label}`,
    password: "correct horse battery staple",
  });
  const accountId = r.account.id;
  const db = accountDb(accountId);
  const company = await systemDb().company.findFirstOrThrow({ where: { accountId } });
  const owner: ScopedActor = { userId: r.user.id, accountId, role: "OWNER", companyScope: null };
  const fhb = await db.fulfillmentConnection.create({
    data: { accountId, companyId: company.id, type: "FHB_V3", name: "FHB syn", liveMode: "LIVE" },
  });
  const eu = await db.fulfillmentConnection.create({
    data: {
      accountId,
      companyId: company.id,
      type: "EUSHIPMENTS",
      name: "EU syn",
      liveMode: "LIVE",
      vendorIds: { companyId: 333 },
    },
  });
  const store = await db.store.create({
    data: {
      accountId,
      companyId: company.id,
      domain: `act-${label}-${Date.now()}.myshopify.com`,
      code: "AC",
      name: "Store",
      currency: "EUR",
      connectionStatus: { ok: true },
      inventoryPushMode: "DRY_RUN",
    },
  });
  const now = new Date();
  await db.storeLocation.create({
    data: {
      accountId,
      storeId: store.id,
      shopifyLocationGid: LOC_A,
      name: "A",
      connectionId: fhb.id,
      fetchedAt: now,
    },
  });
  const locB = await db.storeLocation.create({
    data: {
      accountId,
      storeId: store.id,
      shopifyLocationGid: LOC_B,
      name: "B",
      connectionId: eu.id,
      fetchedAt: now,
    },
  });
  for (const n of [1, 2]) {
    const p = await db.product.create({ data: { accountId, sku: `ACT-${n}`, name: `Синтетичен ${n}` } });
    const link = await db.storeVariantLink.create({
      data: {
        accountId,
        storeId: store.id,
        shopifyVariantGid: `gid://shopify/ProductVariant/${n}`,
        shopifyProductGid: `gid://shopify/Product/${n}`,
        sku: `SH-ACT-${n}`,
        title: `SH-ACT-${n}`,
        productId: p.id,
      },
    });
    await db.shopifyInventoryLevel.create({
      data: {
        accountId,
        storeId: store.id,
        variantLinkId: link.id,
        locationGid: LOC_A,
        inventoryItemGid: item(n),
        available: 4,
        fetchedAt: now,
      },
    });
  }
  return { accountId, db, owner, store, locB, fhb, eu };
}
type S = Awaited<ReturnType<typeof setup>>;

/** Fake Shopify: levels at LOC_B live in `stocked`; answers by operation name and records every call. */
function fakeShopify(
  stocked: Set<string>,
  activate: (vars: Record<string, unknown>) => unknown = (vars) => {
    stocked.add(vars.inventoryItemId as string);
    return {
      inventoryActivate: { inventoryLevel: { id: "gid://shopify/InventoryLevel/1" }, userErrors: [] },
    };
  },
  readBack?: () => unknown,
) {
  const calls: { op: string; vars: Record<string, unknown> }[] = [];
  const client = {
    async query(doc: string, vars: Record<string, unknown>, schema: { parse: (x: unknown) => unknown }) {
      const op = /(?:query|mutation)\s+(\w+)/.exec(doc)![1]!;
      calls.push({ op, vars });
      if (op === "InventoryReadBack") {
        if (readBack) return schema.parse(readBack());
        return schema.parse({
          nodes: (vars.ids as string[]).map((id) => ({
            id,
            tracked: true,
            inventoryLevel: stocked.has(id) ? { quantities: [{ name: "available", quantity: 0 }] } : null,
          })),
        });
      }
      if (op === "InventoryActivate") return schema.parse(await activate(vars));
      throw new Error(`unexpected ${op}`);
    },
  } as unknown as ShopifyClient;
  const clients: PushClients = async () => ({ client });
  return { calls, clients, count: (op: string) => calls.filter((c) => c.op === op).length };
}

const queue = (s: S, expected?: number) =>
  createInventoryActivation(s.owner, { storeId: s.store.id, locationId: s.locB.id, expected });

describe("activate products at a location", () => {
  let s: S;
  beforeEach(async () => {
    s = await setup("t");
  });

  it("counts the candidates of the second location; the preview hints not_stocked_at_location per location", async () => {
    const c = await activationCandidates(s.accountId, s.store.id);
    expect(c.get(LOC_B)!.map((x) => x.inventoryItemGid)).toEqual([item(1), item(2)]);
    expect(c.get(LOC_A)).toEqual([]);
    const plan = await planInventoryPush(s.accountId, s.store.id);
    expect(plan.skipped.not_stocked_at_location).toBe(2);
    expect(plan.notStockedByLocation).toEqual({ [LOC_A]: 0, [LOC_B]: 2 });
  });

  it("OWNER only; another account sees nothing; DISABLED refuses at creation", async () => {
    await expect(
      createInventoryActivation(
        { ...s.owner, role: "ADMIN" },
        { storeId: s.store.id, locationId: s.locB.id },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const other = await setup("other");
    await expect(
      createInventoryActivation(other.owner, { storeId: s.store.id, locationId: s.locB.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      createInventoryActivation(s.owner, { storeId: other.store.id, locationId: s.locB.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await storeActivations(other.accountId, s.store.id)).toEqual([]);
    await s.db.store.update({ where: { id: s.store.id }, data: { inventoryPushMode: "DISABLED" } });
    await expect(queue(s)).rejects.toMatchObject({ code: "inventory_push_disabled" });
  });

  it("an unmapped location is refused; a changed count is not queued", async () => {
    await s.db.storeLocation.update({ where: { id: s.locB.id }, data: { connectionId: null } });
    await expect(queue(s)).rejects.toMatchObject({ code: "location_not_mapped" });
    await s.db.storeLocation.update({ where: { id: s.locB.id }, data: { connectionId: s.eu.id } });
    expect(await queue(s, 5)).toMatchObject({ created: false, reason: "activation_count_changed" });
    expect(await s.db.inventoryActivation.count()).toBe(0);
  });

  it("DRY_RUN records the exact requests (deterministic keys, no quantities) and calls nothing", async () => {
    const r = await queue(s, 2);
    expect(r).toMatchObject({ created: true, items: 2 });
    const sh = fakeShopify(new Set());
    expect(await processInventoryActivation(r.activationId!, sh.clients)).toEqual({
      status: "DRY_RUN_RECORDED",
      refreshInventory: false,
    });
    expect(sh.calls).toHaveLength(0);
    const job = await s.db.inventoryActivation.findUniqueOrThrow({
      where: { id: r.activationId! },
      include: { lines: true },
    });
    const req = job.request as unknown as StoredActivationRequest;
    expect(req.mutation).toBe(ACTIVATE_MUTATION);
    expect(req.items.map((i) => i.variables)).toEqual([
      {
        inventoryItemId: item(1),
        locationId: LOC_B,
        idempotencyKey: activationIdempotencyKey(s.store.id, item(1), LOC_B),
      },
      {
        inventoryItemId: item(2),
        locationId: LOC_B,
        idempotencyKey: activationIdempotencyKey(s.store.id, item(2), LOC_B),
      },
    ]);
    expect(job.lines.every((l) => l.status === "dry_run")).toBe(true);
    expect(
      await s.db.auditLog.count({ where: { entityId: job.id, action: "inventory.activation_queued" } }),
    ).toBe(1);
  });

  it("the mode is evaluated at send time: a job queued in DRY_RUN is REFUSED once the store is DISABLED", async () => {
    const r = await queue(s);
    await s.db.store.update({ where: { id: s.store.id }, data: { inventoryPushMode: "DISABLED" } });
    const sh = fakeShopify(new Set());
    expect(await processInventoryActivation(r.activationId!, sh.clients)).toMatchObject({
      status: "REFUSED",
    });
    expect(sh.calls).toHaveLength(0);
  });

  it("double click / two jobs: one open job per store + location", async () => {
    const [a, b] = await Promise.all([queue(s), queue(s)]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.activationId).toBe(b.activationId);
    expect(await s.db.inventoryActivation.count()).toBe(1);
    expect((await queue(s)).reason).toBe("activation_open");
  });

  it("LIVE: already-active is a success, the other is activated once; parallel processing is skipped", async () => {
    await s.db.store.update({ where: { id: s.store.id }, data: { inventoryPushMode: "LIVE" } });
    const r = await queue(s);
    const stocked = new Set([item(1)]);
    const sh = fakeShopify(stocked);
    const [x, y] = await Promise.all([
      processInventoryActivation(r.activationId!, sh.clients),
      processInventoryActivation(r.activationId!, sh.clients),
    ]);
    expect([x, y]).toContainEqual({ status: "SENT", refreshInventory: true });
    expect([x, y]).toContain("skipped");
    expect(sh.count("InventoryActivate")).toBe(1);
    const sent = sh.calls.find((c) => c.op === "InventoryActivate")!;
    expect(sent.vars).toEqual({
      inventoryItemId: item(2),
      locationId: LOC_B,
      idempotencyKey: activationIdempotencyKey(s.store.id, item(2), LOC_B),
    });
    const lines = await s.db.inventoryActivationLine.findMany({ orderBy: { inventoryItemGid: "asc" } });
    expect(lines.map((l) => l.status)).toEqual(["already", "activated"]);
    expect(await processInventoryActivation(r.activationId!, sh.clients)).toBe("skipped");
  });

  it("userErrors: with no level afterwards the item failed (message kept); with a level it is already active", async () => {
    await s.db.store.update({ where: { id: s.store.id }, data: { inventoryPushMode: "LIVE" } });
    const r = await queue(s);
    const stocked = new Set<string>();
    const sh = fakeShopify(stocked, (vars) => {
      if (vars.inventoryItemId === item(1)) stocked.add(item(1)); // e.g. "already stocked" reported as an error
      return {
        inventoryActivate: {
          inventoryLevel: null,
          userErrors: [{ field: ["inventoryItemId"], message: "Синтетична грешка" }],
        },
      };
    });
    expect(await processInventoryActivation(r.activationId!, sh.clients)).toEqual({
      status: "SENT",
      refreshInventory: true,
    });
    const lines = await s.db.inventoryActivationLine.findMany({ orderBy: { inventoryItemGid: "asc" } });
    expect(lines.map((l) => [l.status, l.error])).toEqual([
      ["already", null],
      ["failed", "Синтетична грешка"],
    ]);
  });

  it("every item failing ends FAILED with an operator task; no inventory refresh", async () => {
    await s.db.store.update({ where: { id: s.store.id }, data: { inventoryPushMode: "LIVE" } });
    const r = await queue(s);
    const sh = fakeShopify(new Set(), () => ({
      inventoryActivate: { inventoryLevel: null, userErrors: [{ field: null, message: "nope" }] },
    }));
    expect(await processInventoryActivation(r.activationId!, sh.clients)).toEqual({
      status: "FAILED",
      refreshInventory: false,
    });
    expect(await s.db.alert.count({ where: { kind: "inventory_activation_failed" } })).toBe(1);
  });

  it("unknown outcome: read back; not there → retried later with the SAME key; there → activated", async () => {
    await s.db.store.update({ where: { id: s.store.id }, data: { inventoryPushMode: "LIVE" } });
    const r = await queue(s);
    const stocked = new Set<string>();
    const keys: string[] = [];
    let mode: "lost" | "applied-then-timeout" | "ok" = "lost";
    const sh = fakeShopify(stocked, (vars) => {
      keys.push(`${vars.inventoryItemId as string}|${vars.idempotencyKey as string}`);
      if (mode === "lost") throw new ShopifyError("http_error", "HTTP 502", 502);
      stocked.add(vars.inventoryItemId as string);
      if (mode === "applied-then-timeout") throw new ShopifyError("http_error", "HTTP 504", 504);
      return { inventoryActivate: { inventoryLevel: { id: "x" }, userErrors: [] } };
    });
    expect(await processInventoryActivation(r.activationId!, sh.clients)).toMatchObject({
      status: "PENDING",
    });
    mode = "applied-then-timeout";
    const later = new Date(Date.now() + 3_600_000);
    expect(await processInventoryActivation(r.activationId!, sh.clients, later)).toEqual({
      status: "SENT",
      refreshInventory: true,
    });
    const byItem = (n: number) => keys.filter((k) => k.startsWith(`${item(n)}|`));
    expect(byItem(1)).toHaveLength(2);
    expect(new Set(byItem(1)).size).toBe(1); // same key on the retry
    expect((await s.db.inventoryActivationLine.findMany()).every((l) => l.status === "activated")).toBe(true);
  });

  it("an unknown outcome found applied by the next run's read-back counts as activated, not 'already'", async () => {
    await s.db.store.update({ where: { id: s.store.id }, data: { inventoryPushMode: "LIVE" } });
    const r = await queue(s);
    const stocked = new Set<string>();
    let readFails = true;
    const sh = fakeShopify(
      stocked,
      (vars) => {
        stocked.add(vars.inventoryItemId as string);
        throw new ShopifyError("http_error", "HTTP 502", 502);
      },
      () => {
        // first batch read works (nothing stocked), the per-item read-backs after the 502 fail
        const nodes = [item(1), item(2)].map((id) => ({
          id,
          tracked: true,
          inventoryLevel: stocked.has(id) ? { quantities: [] } : null,
        }));
        if (stocked.size > 0 && readFails) throw new ShopifyError("http_error", "HTTP 503", 503);
        return { nodes };
      },
    );
    expect(await processInventoryActivation(r.activationId!, sh.clients)).toMatchObject({
      status: "PENDING",
    });
    readFails = false;
    expect(
      await processInventoryActivation(r.activationId!, sh.clients, new Date(Date.now() + 3_600_000)),
    ).toMatchObject({ status: "SENT" });
    const lines = await s.db.inventoryActivationLine.findMany();
    expect(lines.map((l) => l.status)).toEqual(["activated", "activated"]);
  });

  it("missing write_inventory (ACCESS_DENIED) fails definitely without a retry", async () => {
    await s.db.store.update({ where: { id: s.store.id }, data: { inventoryPushMode: "LIVE" } });
    const r = await queue(s);
    const sh = fakeShopify(new Set(), () => {
      throw new ShopifyError("graphql_error", "Access denied", undefined, ["ACCESS_DENIED"]);
    });
    expect(await processInventoryActivation(r.activationId!, sh.clients)).toMatchObject({ status: "FAILED" });
    expect(sh.count("InventoryActivate")).toBe(2);
  });

  it("the kill switch parks the job; the sweep queues it again once lifted", async () => {
    await s.db.store.update({ where: { id: s.store.id }, data: { inventoryPushMode: "LIVE" } });
    const r = await queue(s);
    await systemDb().account.update({ where: { id: s.accountId }, data: { outboxPaused: true } });
    const sh = fakeShopify(new Set());
    expect(await processInventoryActivation(r.activationId!, sh.clients)).toMatchObject({ status: "PAUSED" });
    expect(sh.calls).toHaveLength(0);
    await systemDb().account.update({ where: { id: s.accountId }, data: { outboxPaused: false } });
    expect((await sweepInventoryActivations()).ready.map((x) => x.id)).toContain(r.activationId);
  });
});

describe("activation: auditor fixes", () => {
  let s: S;
  beforeEach(async () => {
    s = await setup("fix");
  });

  it("confirmed as a dry run, paused, then the store raised to LIVE: REFUSED, nothing sent", async () => {
    const r = await queue(s, 2); // store is DRY_RUN: the owner saw the dry-run confirmation
    expect(
      (await s.db.inventoryActivation.findUniqueOrThrow({ where: { id: r.activationId! } })).createdMode,
    ).toBe("DRY_RUN");
    await systemDb().account.update({ where: { id: s.accountId }, data: { outboxPaused: true } });
    const sh = fakeShopify(new Set());
    expect(await processInventoryActivation(r.activationId!, sh.clients)).toMatchObject({ status: "PAUSED" });
    await s.db.store.update({ where: { id: s.store.id }, data: { inventoryPushMode: "LIVE" } });
    await systemDb().account.update({ where: { id: s.accountId }, data: { outboxPaused: false } });
    const { ready } = await sweepInventoryActivations();
    expect(ready.map((x) => x.id)).toContain(r.activationId);
    await processInventoryActivation(r.activationId!, sh.clients);
    expect(sh.count("InventoryActivate")).toBe(0);
    expect(sh.calls).toHaveLength(0);
    const job = await s.db.inventoryActivation.findUniqueOrThrow({ where: { id: r.activationId! } });
    expect(job).toMatchObject({
      status: "REFUSED",
      lastError: "mode_raised_after_confirm",
      evaluatedMode: "LIVE",
    });
    // a new OWNER click in LIVE is what sends
    const again = await queue(s, 2);
    expect(again.created).toBe(true);
    expect(await processInventoryActivation(again.activationId!, sh.clients)).toMatchObject({
      status: "SENT",
    });
    expect(sh.count("InventoryActivate")).toBe(2);
  });

  it("THROTTLED: the line stays planned, the attempt is given back, the next run sends it with the same key", async () => {
    await s.db.store.update({ where: { id: s.store.id }, data: { inventoryPushMode: "LIVE" } });
    const r = await queue(s);
    const stocked = new Set<string>();
    const keys: string[] = [];
    let throttle = true;
    const sh = fakeShopify(stocked, (vars) => {
      keys.push(`${vars.inventoryItemId as string}|${vars.idempotencyKey as string}`);
      if (throttle) throw new ShopifyError("throttled", "still throttled after retries");
      stocked.add(vars.inventoryItemId as string);
      return { inventoryActivate: { inventoryLevel: { id: "x" }, userErrors: [] } };
    });
    const t0 = new Date();
    expect(await processInventoryActivation(r.activationId!, sh.clients, t0)).toEqual({
      status: "PENDING",
      refreshInventory: false,
    });
    expect(sh.count("InventoryActivate")).toBe(1); // the run stops at the first throttle
    const job = await s.db.inventoryActivation.findUniqueOrThrow({
      where: { id: r.activationId! },
      include: { lines: true },
    });
    expect(job.attempts).toBe(0);
    expect(job.nextAttemptAt!.getTime()).toBe(t0.getTime() + THROTTLE_BACKOFF_MS);
    expect(job.lines.every((l) => l.status === "planned")).toBe(true);
    // a GraphQL THROTTLED code (definite-rejection list) and an HTTP 429 are throttling too, never "failed"
    for (const [i, err] of [
      new ShopifyError("graphql_error", "Throttled", undefined, ["THROTTLED"]),
      new ShopifyError("http_error", "HTTP 429", 429),
    ].entries()) {
      const sh2 = fakeShopify(stocked, () => {
        throw err;
      });
      const later = new Date(t0.getTime() + THROTTLE_BACKOFF_MS * (i + 1));
      expect(await processInventoryActivation(r.activationId!, sh2.clients, later)).toMatchObject({
        status: "PENDING",
      });
      expect((await s.db.inventoryActivationLine.findMany()).every((l) => l.status === "planned")).toBe(true);
    }
    throttle = false;
    expect(
      await processInventoryActivation(r.activationId!, sh.clients, new Date(t0.getTime() + 3_600_000)),
    ).toEqual({ status: "SENT", refreshInventory: true });
    const lines = await s.db.inventoryActivationLine.findMany({ orderBy: { inventoryItemGid: "asc" } });
    expect(lines.map((l) => l.status)).toEqual(["activated", "activated"]);
    const byItem = (n: number) => keys.filter((k) => k.startsWith(`${item(n)}|`));
    expect(new Set(byItem(1))).toEqual(
      new Set([`${item(1)}|${activationIdempotencyKey(s.store.id, item(1), LOC_B)}`]),
    );
  });

  it("a worker whose claim was taken over (stale re-arm + new claim) stops before the next item", async () => {
    await s.db.store.update({ where: { id: s.store.id }, data: { inventoryPushMode: "LIVE" } });
    const r = await queue(s);
    const stocked = new Set<string>();
    const sh = fakeShopify(stocked, async (vars) => {
      stocked.add(vars.inventoryItemId as string);
      // meanwhile: the sweep re-armed it and another worker claimed it (attempts moved on)
      await systemDb().inventoryActivation.update({
        where: { id: r.activationId! },
        data: { status: "SENDING", attempts: 2 },
      });
      return { inventoryActivate: { inventoryLevel: { id: "x" }, userErrors: [] } };
    });
    const res = await processInventoryActivation(r.activationId!, sh.clients);
    expect(res).toEqual({ status: "SENDING", refreshInventory: false });
    expect(sh.count("InventoryActivate")).toBe(1);
    // the first worker neither finalized nor audited the job it no longer owns
    const job = await s.db.inventoryActivation.findUniqueOrThrow({ where: { id: r.activationId! } });
    expect(job).toMatchObject({ status: "SENDING", attempts: 2, sentAt: null });
  });

  it("the per-location hint counts exactly what the button activates (tracked, one per inventory item)", async () => {
    const now = new Date();
    const link = async (n: number, inventoryItemGid: string, tracked: boolean) => {
      const p = await s.db.product.create({
        data: { accountId: s.accountId, sku: `ACT-X${n}`, name: `Синтетичен X${n}` },
      });
      const l = await s.db.storeVariantLink.create({
        data: {
          accountId: s.accountId,
          storeId: s.store.id,
          shopifyVariantGid: `gid://shopify/ProductVariant/9${n}`,
          shopifyProductGid: `gid://shopify/Product/9${n}`,
          sku: `SH-ACT-X${n}`,
          title: `SH-ACT-X${n}`,
          productId: p.id,
        },
      });
      await s.db.shopifyInventoryLevel.create({
        data: {
          accountId: s.accountId,
          storeId: s.store.id,
          variantLinkId: l.id,
          locationGid: LOC_A,
          inventoryItemGid,
          available: 1,
          tracked,
          fetchedAt: now,
        },
      });
    };
    await link(1, item(3), false); // untracked: the push skips it, the button does not activate it
    await link(2, item(1), true); // a second link sharing item 1: activated once
    const plan = await planInventoryPush(s.accountId, s.store.id);
    const button = (await activationCandidates(s.accountId, s.store.id)).get(LOC_B)!;
    expect(button).toHaveLength(2);
    expect(plan.notStockedByLocation[LOC_B]).toBe(button.length);
    expect(plan.skipped.not_stocked_at_location).toBe(4); // the raw skip count stays variant × location
  });
});

describe("location names from the read", () => {
  it("a placeholder Shopify name falls back to the fulfillment service name", async () => {
    const s = await setup("names");
    const client = {
      async query(doc: string, _vars: unknown, schema: { parse: (x: unknown) => unknown }) {
        if (doc.includes("StoreLocations"))
          return schema.parse({
            locations: {
              nodes: [
                {
                  id: LOC_A,
                  name: "#2",
                  isActive: true,
                  address: { city: null },
                  fulfillmentService: { handle: "syn-a", serviceName: "Синтетичен склад А" },
                },
                {
                  id: LOC_B,
                  name: "Склад Б",
                  isActive: true,
                  address: { city: "Град" },
                  fulfillmentService: null,
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          });
        return schema.parse({
          location: { id: LOC_A, inventoryLevels: { nodes: [], pageInfo: { hasNextPage: false } } },
        });
      },
    } as unknown as ShopifyClient;
    await syncStoreInventory(s.accountId, s.store.id, async () => ({ client }));
    const names = await s.db.storeLocation.findMany({ orderBy: { shopifyLocationGid: "asc" } });
    expect(names.map((l) => l.name)).toEqual(["Синтетичен склад А (#2)", "Склад Б"]);
  });
});
