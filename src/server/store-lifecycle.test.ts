import { createHmac } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TokenProvider } from "@/integrations/shopify/token";
import { bootstrapOwner } from "@/server/auth/users";
import { accountDb, systemDb, withAccountTransaction } from "@/server/db/client";
import { QUEUES } from "@/server/jobs/queues";
import { liveCheckTargets } from "@/server/api-watcher/live-check";
import { connectedStore, registerShopifyWorkers, runRemoveWebhooks } from "@/server/shopify/jobs";
import { processShopifyWebhook, receiveShopifyWebhook } from "@/server/shopify/webhooks";
import { registerStockWorkers } from "@/server/stock/jobs";
import { createInventoryPush } from "@/server/stock/push";
import { syncStoreInventory } from "@/server/stock/shopify-inventory";
import { createStore, getStore, listStores, type ScopedActor } from "./stores";
import {
  archiveStore,
  deleteStore,
  purgeStore,
  restoreStore,
  storeEditLocks,
  storeUsage,
  updateStoreDetails,
} from "./store-lifecycle";

// Synthetic data only (CLAUDE.md: no real business data in the repo).
const SECRET = "lifecycle-client-secret-0001";
const URI = "https://crm.example.com/api/webhooks/shopify";
const tag = Date.now().toString(36);
const dom = (n: string) => `lc-${n}-${tag}.myshopify.com`;

/** Fake Shopify: token endpoint + GraphQL by operation name (never a real call). */
function fakeShopify(routes: Record<string, (vars: Record<string, unknown>) => unknown>) {
  const ops: string[] = [];
  const hosts: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    hosts.push(new URL(url).hostname);
    if (url.endsWith("/admin/oauth/access_token"))
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 86399 }), { status: 200 });
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "?";
    ops.push(op);
    const handler = routes[op];
    if (!handler) throw new Error(`unexpected operation ${op}`);
    return new Response(JSON.stringify({ data: handler(body.variables) }), { status: 200 });
  });
  return { ops, hosts, opts: { fetchImpl, tokens: new TokenProvider(fetchImpl), sleep: async () => {} } };
}

/** Fake pg-boss: collects worker handlers and every job sent. */
function fakeBoss() {
  const handlers = new Map<string, (jobs: { data: unknown }[]) => Promise<void>>();
  const sent: { name: string; data: { accountId?: string; storeId?: string } }[] = [];
  const boss = {
    work: async (name: string, _o: unknown, fn: (jobs: { data: unknown }[]) => Promise<void>) => {
      handlers.set(name, fn);
      return name;
    },
    send: async (name: string, data: { accountId?: string; storeId?: string }) => {
      sent.push({ name, data });
      return `job-${sent.length}`;
    },
  } as unknown as PgBoss;
  return { boss, handlers, sent };
}

describe("store edit, archive and delete", () => {
  let owner: ScopedActor;
  let admin: ScopedActor;
  let accountId: string;
  let companyA: string;
  let companyB: string;
  let companyOtherLine: string;
  let connectionId: string;

  const connected = { ok: true, at: new Date().toISOString() };
  const newStore = async (n: string, code: string, over: Record<string, unknown> = {}) => {
    const s = await createStore(owner, {
      companyId: companyA,
      name: `Store ${n}`,
      domain: dom(n),
      code,
      currency: "EUR",
      countries: ["BG"],
      clientId: `client-id-${n}-0001`,
      clientSecret: SECRET,
      ...over,
    });
    return s.id;
  };
  const addOrder = (storeId: string, number: string, status = "IMPORTED") =>
    systemDb().order.create({
      data: {
        accountId,
        storeId,
        companyId: companyA,
        source: "SHOPIFY",
        number,
        currency: "EUR",
        subtotal: 1,
        total: 1,
        paymentMethod: "COD",
        placedAt: new Date(),
        status: status as "IMPORTED",
      },
    });

  beforeAll(async () => {
    const r = await bootstrapOwner({
      email: `lc-${tag}@example.com`,
      name: "O",
      accountName: "Lifecycle group",
      password: "correct horse battery staple",
    });
    accountId = r.account.id;
    owner = { userId: r.user.id, accountId, role: "OWNER", companyScope: null };
    admin = { ...owner, role: "ADMIN" };
    const db = systemDb();
    const line1 = await db.productLine.create({ data: { accountId, name: "Line 1" } });
    const line2 = await db.productLine.create({ data: { accountId, name: "Line 2" } });
    companyA = (await db.company.findFirstOrThrow({ where: { accountId } })).id;
    await db.company.update({ where: { id: companyA }, data: { lineId: line1.id } });
    companyB = (await db.company.create({ data: { accountId, name: "B", lineId: line1.id } })).id;
    companyOtherLine = (await db.company.create({ data: { accountId, name: "C", lineId: line2.id } })).id;
    connectionId = (
      await db.fulfillmentConnection.create({
        data: { accountId, companyId: companyA, type: "FHB_V3", name: "FHB test" },
      })
    ).id;
  });

  it("edits name, currency, countries, code and domain of an empty store (audited before/after)", async () => {
    const id = await newStore("edit", "ED1");
    await accountDb(accountId).store.update({
      where: { id },
      data: { connectionStatus: connected, webhookStatus: { ok: true, topics: ["ORDERS_CREATE"] } },
    });
    await accountDb(accountId).storeVariantLink.create({
      data: {
        accountId,
        storeId: id,
        shopifyVariantGid: "gid://shopify/ProductVariant/1",
        shopifyProductGid: "gid://shopify/Product/1",
        title: "V",
      },
    });
    const r = await updateStoreDetails(admin, id, {
      name: " Renamed ",
      companyId: companyA,
      currency: "ron",
      countries: ["ro", "bg"],
      domain: `https://${dom("edit2")}/admin`,
      code: "ed2",
    });
    expect(r).toMatchObject({ domainChanged: true, codeChanged: true, companyChanged: false });
    const s = await getStore(owner, id);
    expect(s).toMatchObject({ name: "Renamed", currency: "RON", countries: ["RO", "BG"], code: "ED2" });
    expect(s.domain).toBe(dom("edit2"));
    // A different shop: the old test, webhooks and variants say nothing about it.
    expect(s.connectionStatus).toEqual({});
    expect(s.webhookStatus).toEqual({});
    expect(await accountDb(accountId).storeVariantLink.count({ where: { storeId: id } })).toBe(0);
    const audit = await accountDb(accountId).auditLog.findFirstOrThrow({
      where: { entityId: id, action: "store.details" },
    });
    expect(audit.before).toMatchObject({ name: "Store edit", code: "ED1", currency: "EUR" });
    expect(audit.after).toMatchObject({ name: "Renamed", code: "ED2", currency: "RON" });
  });

  it("locks the code and the domain once the store has an order; uniqueness in the group", async () => {
    const id = await newStore("lock", "LK1");
    await newStore("other", "OT1");
    const base = {
      name: "Store lock",
      companyId: companyA,
      currency: "EUR",
      countries: ["BG"],
      domain: dom("lock"),
      code: "LK1",
    };
    await expect(updateStoreDetails(owner, id, { ...base, code: "OT1" })).rejects.toMatchObject({
      code: "code_taken",
    });
    await expect(updateStoreDetails(owner, id, { ...base, domain: dom("other") })).rejects.toMatchObject({
      code: "domain_taken",
    });
    await expect(updateStoreDetails(owner, id, { ...base, code: "toolong" })).rejects.toThrow();
    await expect(updateStoreDetails(owner, id, { ...base, domain: "evil.com" })).rejects.toThrow();

    const order = await addOrder(id, "L-1");
    expect(storeEditLocks(await storeUsage(accountId, id))).toEqual({
      code: "code_locked",
      domain: "domain_locked",
    });
    await expect(updateStoreDetails(owner, id, { ...base, code: "LK2" })).rejects.toMatchObject({
      code: "code_locked",
    });
    await expect(updateStoreDetails(owner, id, { ...base, domain: dom("lock2") })).rejects.toMatchObject({
      code: "domain_locked",
    });
    // Fulfillments alone lock the code too (the external id carries it).
    await systemDb().fulfillment.create({
      data: { accountId, orderId: order.id, connectionId, externalId: `LK1-L-1-${tag}`, status: "ACCEPTED" },
    });
    expect((await storeUsage(accountId, id)).fulfillments).toBe(1);
    // Everything else stays editable.
    await updateStoreDetails(owner, id, { ...base, name: "Still editable", countries: ["BG", "GR"] });
    expect((await getStore(owner, id)).countries).toEqual(["BG", "GR"]);
  });

  it("moving to another company affects only future orders and respects product lines", async () => {
    const id = await newStore("move", "MV1");
    const order = await addOrder(id, "M-1");
    const base = { name: "Store move", currency: "EUR", countries: ["BG"], domain: dom("move"), code: "MV1" };
    const r = await updateStoreDetails(owner, id, { ...base, companyId: companyB });
    expect(r.companyChanged).toBe(true);
    expect((await getStore(owner, id)).companyId).toBe(companyB);
    expect((await systemDb().order.findUniqueOrThrow({ where: { id: order.id } })).companyId).toBe(companyA);

    // With a matched variant, the new company must be in the same line.
    const product = await systemDb().product.create({
      data: { accountId, sku: `LC-${tag}`, name: "P" },
    });
    await accountDb(accountId).storeVariantLink.create({
      data: {
        accountId,
        storeId: id,
        shopifyVariantGid: "gid://shopify/ProductVariant/9",
        shopifyProductGid: "gid://shopify/Product/9",
        title: "V",
        productId: product.id,
      },
    });
    await expect(
      updateStoreDetails(owner, id, { ...base, companyId: companyOtherLine }),
    ).rejects.toMatchObject({ code: "line_mismatch" });
    await updateStoreDetails(owner, id, { ...base, companyId: companyA }); // same line: fine
    // A company outside the group is not found.
    await expect(updateStoreDetails(owner, id, { ...base, companyId: "nope" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("RBAC: owners/admins edit, only owners archive, restore or delete; tenant and company scope", async () => {
    const id = await newStore("rbac", "RB1");
    const input = {
      name: "X",
      companyId: companyA,
      currency: "EUR",
      countries: [],
      domain: dom("rbac"),
      code: "RB1",
    };
    await expect(updateStoreDetails({ ...owner, role: "OPERATOR" }, id, input)).rejects.toThrow(/Forbidden/);
    await expect(archiveStore(admin, id)).rejects.toThrow(/Forbidden/);
    await expect(restoreStore(admin, id)).rejects.toThrow(/Forbidden/);
    await expect(deleteStore(admin, id, { confirmCode: "RB1" })).rejects.toThrow(/Forbidden/);
    // Another group's owner cannot see it at all.
    const other = await bootstrapOwner({
      email: `lc2-${tag}@example.com`,
      name: "O2",
      accountName: "Other group",
      password: "correct horse battery staple",
    });
    const stranger: ScopedActor = {
      userId: other.user.id,
      accountId: other.account.id,
      role: "OWNER",
      companyScope: null,
    };
    await expect(updateStoreDetails(stranger, id, input)).rejects.toMatchObject({ code: "not_found" });
    await expect(archiveStore(stranger, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteStore(stranger, id, { confirmCode: "RB1" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await systemDb().store.count({ where: { id } })).toBe(1);
    // A member limited to company B cannot touch company A's store, nor move a store into a company outside scope.
    const limited = { ...admin, companyScope: [companyB] };
    await expect(updateStoreDetails(limited, id, input)).rejects.toMatchObject({ code: "not_found" });
  });

  it("archive stops every store job and webhook intake; restore undoes it", async () => {
    const id = await newStore("arch", "AR1");
    await accountDb(accountId).store.update({
      where: { id },
      data: {
        connectionStatus: connected,
        webhookStatus: { ok: true, topics: ["ORDERS_CREATE"] },
        inventoryPushMode: "DRY_RUN",
      },
    });
    await addOrder(id, "A-1", "READY");
    await addOrder(id, "A-2", "DELIVERED");
    expect(await connectedStore(accountId, id)).toBe(true);
    // Before: the crons queue it.
    const before = fakeBoss();
    await registerShopifyWorkers(before.boss, { pollingIntervalSeconds: 1 });
    await registerStockWorkers(before.boss, { pollingIntervalSeconds: 1 });
    await before.handlers.get(QUEUES.shopifyReconcile.name)!([]);
    await before.handlers.get(QUEUES.stockShopifyInventoryTick.name)!([]);
    expect(before.sent.filter((j) => j.data.storeId === id).map((j) => j.name)).toEqual([
      QUEUES.shopifySyncOrders.name,
      QUEUES.stockShopifyInventory.name,
    ]);

    const r = await archiveStore(owner, id);
    expect(r).toEqual({ archived: true, notSent: 1 });
    expect(await archiveStore(owner, id)).toMatchObject({ archived: false }); // idempotent
    const s = await getStore(owner, id);
    expect(s.archivedAt).toBeInstanceOf(Date);
    expect(s.archivedById).toBe(owner.userId);

    // Crons and per-store jobs skip it.
    const after = fakeBoss();
    await registerShopifyWorkers(after.boss, { pollingIntervalSeconds: 1 });
    await registerStockWorkers(after.boss, { pollingIntervalSeconds: 1 });
    await after.handlers.get(QUEUES.shopifyReconcile.name)!([]);
    await after.handlers.get(QUEUES.stockShopifyInventoryTick.name)!([]);
    expect(after.sent.filter((j) => j.data.storeId === id)).toEqual([]);
    expect(await connectedStore(accountId, id)).toBe(false);
    const job = { accountId, storeId: id, callbackUrl: URI };
    await after.handlers.get(QUEUES.shopifyTestConnection.name)!([{ data: job }]); // would throw on a real call
    await after.handlers.get(QUEUES.shopifySyncOrders.name)!([{ data: { ...job, mode: "reconcile" } }]);
    await after.handlers.get(QUEUES.shopifySyncProducts.name)!([{ data: job }]);
    await after.handlers.get(QUEUES.shopifyRegisterWebhooks.name)!([{ data: job }]);
    expect(after.sent.filter((j) => j.data.storeId === id)).toEqual([]);
    const never = vi.fn();
    expect(await syncStoreInventory(accountId, id, never)).toMatchObject({ skipped: true });
    expect(never).not.toHaveBeenCalled();
    await expect(createInventoryPush(id, { kind: "user", actor: owner })).rejects.toMatchObject({
      code: "store_archived",
    });
    expect((await liveCheckTargets()).some((t) => t.id === id)).toBe(false);
    // Hidden from pickers, still listed with includeArchived; its orders stay.
    const ctx = { accountId, companyScope: null, activeCompanyId: null };
    expect((await listStores(ctx)).some((x) => x.id === id)).toBe(false);
    expect((await listStores(ctx, { includeArchived: true })).some((x) => x.id === id)).toBe(true);
    expect(await accountDb(accountId).order.count({ where: { storeId: id } })).toBe(2);
    // Editing an archived store is refused.
    await expect(
      updateStoreDetails(owner, id, {
        name: "X",
        companyId: companyA,
        currency: "EUR",
        countries: [],
        domain: dom("arch"),
        code: "AR1",
      }),
    ).rejects.toMatchObject({ code: "store_archived" });

    // Webhook intake: acknowledged and ignored, nothing stored.
    const body = JSON.stringify({ admin_graphql_api_id: "gid://shopify/Order/77" });
    const headers = new Headers({
      "x-shopify-shop-domain": dom("arch"),
      "x-shopify-topic": "orders/create",
      "x-shopify-webhook-id": `wh-arch-${tag}`,
      "x-shopify-hmac-sha256": createHmac("sha256", SECRET).update(body).digest("base64"),
    });
    expect(await receiveShopifyWebhook(body, headers)).toMatchObject({
      status: 200,
      eventId: null,
      ignored: true,
    });
    expect(
      await accountDb(accountId).webhookEvent.count({ where: { dedupeKey: `${id}:wh-arch-${tag}` } }),
    ).toBe(0);
    // An event stored before the archive is ignored by the worker (no Shopify call).
    const ev = await accountDb(accountId).webhookEvent.create({
      data: {
        accountId,
        source: "SHOPIFY",
        dedupeKey: `${id}:wh-old-${tag}`,
        topic: "orders/create",
        headers: { storeId: id },
        payload: { admin_graphql_api_id: "gid://shopify/Order/78" },
      },
    });
    expect(await processShopifyWebhook(accountId, ev.id)).toBe("IGNORED");

    // Webhook removal job: deletes only our subscriptions, records the result.
    const deleted: string[] = [];
    const fake = fakeShopify({
      WebhookSubscriptions: () => ({
        webhookSubscriptions: {
          nodes: [
            { id: "gid://shopify/WebhookSubscription/1", topic: "ORDERS_CREATE", uri: URI },
            { id: "gid://shopify/WebhookSubscription/2", topic: "ORDERS_UPDATED", uri: URI },
          ],
        },
      }),
      WebhookDelete: (v) => {
        deleted.push(v.id as string);
        return v.id === "gid://shopify/WebhookSubscription/2" && deleted.length === 2
          ? {
              webhookSubscriptionDelete: {
                deletedWebhookSubscriptionId: null,
                userErrors: [{ field: ["id"], message: "Try again" }],
              },
            }
          : { webhookSubscriptionDelete: { deletedWebhookSubscriptionId: v.id, userErrors: [] } };
      },
    });
    expect(await runRemoveWebhooks(job, fake.opts)).toBe("failed");
    expect((await getStore(owner, id)).webhookStatus).toMatchObject({
      ok: false,
      removed: false,
      topics: ["ORDERS_UPDATED"],
    });
    expect(await runRemoveWebhooks(job, fake.opts)).toBe("removed"); // retry succeeds
    expect((await getStore(owner, id)).webhookStatus).toMatchObject({ ok: true, removed: true, topics: [] });

    // Restore: back in the jobs, connection to be re-tested (the test re-registers the webhooks).
    expect(await restoreStore(owner, id)).toEqual({ restored: true });
    const restored = await getStore(owner, id);
    expect(restored.archivedAt).toBeNull();
    expect(restored.connectionStatus).toEqual({});
    expect((await listStores(ctx)).some((x) => x.id === id)).toBe(true);
    // A removal job queued before the restore does nothing now.
    expect(await runRemoveWebhooks(job, fakeShopify({}).opts)).toBe("skipped");
    const actions = (
      await accountDb(accountId).auditLog.findMany({ where: { entityId: id }, select: { action: true } })
    ).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["store.archive", "store.restore"]));
  });

  it("delete is refused for a store with history and offers archive instead", async () => {
    const id = await newStore("hist", "HI1");
    await addOrder(id, "H-1", "DELIVERED");
    await expect(deleteStore(owner, id, { confirmCode: "HI1" })).rejects.toMatchObject({
      code: "has_orders",
    });
    const rule = await accountDb(accountId).routingRule.create({
      data: {
        accountId,
        name: "R",
        priority: 1,
        connectionId,
        match: { storeIds: [await newStore("rule", "RU1")] },
      },
    });
    const ruleStore = (rule.match as { storeIds: string[] }).storeIds[0]!;
    await expect(deleteStore(owner, ruleStore, { confirmCode: "RU1" })).rejects.toMatchObject({
      code: "in_routing_rules",
    });
    expect(await systemDb().store.count({ where: { id: { in: [id, ruleStore] } } })).toBe(2);
  });

  it("deletes an empty store with its own rows; the credential only when nobody else uses it", async () => {
    const id = await newStore("del", "DL1");
    const db = accountDb(accountId);
    const cred = (await db.store.findUniqueOrThrow({ where: { id } })).credentialId!;
    // A second store sharing the same app credential.
    const sharing = await newStore("share", "SH1", {
      clientId: undefined,
      clientSecret: undefined,
      credentialId: cred,
    });
    const link = await db.storeVariantLink.create({
      data: {
        accountId,
        storeId: id,
        shopifyVariantGid: "gid://shopify/ProductVariant/5",
        shopifyProductGid: "gid://shopify/Product/5",
        title: "V",
      },
    });
    await db.storeLocation.create({
      data: {
        accountId,
        storeId: id,
        shopifyLocationGid: "gid://shopify/Location/1",
        name: "L",
        fetchedAt: new Date(),
      },
    });
    await db.shopifyInventoryLevel.create({
      data: {
        accountId,
        storeId: id,
        variantLinkId: link.id,
        locationGid: "gid://shopify/Location/1",
        inventoryItemGid: "gid://shopify/InventoryItem/5",
        available: 3,
        fetchedAt: new Date(),
      },
    });
    await expect(deleteStore(owner, id, { confirmCode: "XX" })).rejects.toMatchObject({
      code: "confirm_mismatch",
    });
    expect(await deleteStore(owner, id, { confirmCode: "dl1" })).toEqual({ pending: false });
    expect(await systemDb().store.count({ where: { id } })).toBe(0);
    expect(await db.storeVariantLink.count({ where: { storeId: id } })).toBe(0);
    expect(await db.storeLocation.count({ where: { storeId: id } })).toBe(0);
    expect(await db.shopifyInventoryLevel.count({ where: { storeId: id } })).toBe(0);
    expect(await db.credential.count({ where: { id: cred } })).toBe(1); // still used by SH1
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: id, action: "store.delete" } });
    expect(audit.before).toMatchObject({ code: "DL1", name: "Store del" });
    expect(audit.after).toMatchObject({
      variantLinks: 1,
      locations: 1,
      inventoryLevels: 1,
      credentialDeleted: false,
    });

    // The last user of the credential: removed from the vault too.
    await deleteStore(owner, sharing, { confirmCode: "SH1" });
    expect(await db.credential.count({ where: { id: cred } })).toBe(0);
    expect(await purgeStore(accountId, sharing, {})).toBe(false); // already gone
  });

  it("a connected store with webhooks is deleted only after the removal job (webhooks first)", async () => {
    const id = await newStore("wh", "WH1");
    await accountDb(accountId).store.update({
      where: { id },
      data: { connectionStatus: connected, webhookStatus: { ok: true, topics: ["ORDERS_CREATE"] } },
    });
    expect(await deleteStore(owner, id, { confirmCode: "WH1" })).toEqual({ pending: true });
    const s = await getStore(owner, id);
    expect(s.archivedAt).toBeInstanceOf(Date); // no jobs while waiting
    expect(s.webhookStatus).toMatchObject({ deleteRequested: true });
    const failing = fakeShopify({
      WebhookSubscriptions: () => ({
        webhookSubscriptions: {
          nodes: [{ id: "gid://shopify/WebhookSubscription/9", topic: "ORDERS_CREATE", uri: URI }],
        },
      }),
      WebhookDelete: () => ({
        webhookSubscriptionDelete: {
          deletedWebhookSubscriptionId: null,
          userErrors: [{ field: null, message: "No" }],
        },
      }),
    });
    const job = { accountId, storeId: id, callbackUrl: URI, deleteAfter: true, userId: owner.userId };
    expect(await runRemoveWebhooks(job, failing.opts)).toBe("failed");
    expect(await systemDb().store.count({ where: { id } })).toBe(1); // failure shown, retryable
    const ok = fakeShopify({
      WebhookSubscriptions: () => ({
        webhookSubscriptions: {
          nodes: [{ id: "gid://shopify/WebhookSubscription/9", topic: "ORDERS_CREATE", uri: URI }],
        },
      }),
      WebhookDelete: (v) => ({
        webhookSubscriptionDelete: { deletedWebhookSubscriptionId: v.id, userErrors: [] },
      }),
    });
    expect(await runRemoveWebhooks(job, ok.opts)).toBe("deleted");
    expect(ok.ops).toEqual(["WebhookSubscriptions", "WebhookDelete"]);
    expect(await systemDb().store.count({ where: { id } })).toBe(0);
  });

  it("an owner may force the delete after the webhook removal failed", async () => {
    const id = await newStore("force", "FO1");
    await accountDb(accountId).store.update({
      where: { id },
      data: { connectionStatus: connected, webhookStatus: { ok: true, topics: ["ORDERS_CREATE"] } },
    });
    expect(await deleteStore(owner, id, { confirmCode: "FO1", force: true })).toEqual({ pending: true });
    await accountDb(accountId).store.update({
      where: { id },
      data: { webhookStatus: { ok: false, topics: ["ORDERS_CREATE"], deleteRequested: true, errors: ["x"] } },
    });
    expect(await deleteStore(owner, id, { confirmCode: "FO1", force: true })).toEqual({ pending: false });
    expect(await systemDb().store.count({ where: { id } })).toBe(0);
  });
  const okRemoval = () =>
    fakeShopify({
      WebhookSubscriptions: () => ({
        webhookSubscriptions: {
          nodes: [{ id: "gid://shopify/WebhookSubscription/9", topic: "ORDERS_CREATE", uri: URI }],
        },
      }),
      WebhookDelete: (v) => ({
        webhookSubscriptionDelete: { deletedWebhookSubscriptionId: v.id, userErrors: [] },
      }),
    });
  const details = (id: string, over: Record<string, unknown> = {}) =>
    getStore(owner, id).then((s) => ({
      name: s.name,
      companyId: s.companyId!,
      currency: s.currency,
      countries: s.countries,
      domain: s.domain,
      code: s.code,
      ...over,
    }));
  /** Another group (account) with its own owner, for shops connected in more than one group. */
  const otherGroup = async (n: string) => {
    const r = await bootstrapOwner({
      email: `lc-${n}-${tag}@example.com`,
      name: "O2",
      accountName: `Lifecycle group ${n}`,
      password: "correct horse battery staple",
    });
    const actor: ScopedActor = {
      userId: r.user.id,
      accountId: r.account.id,
      role: "OWNER",
      companyScope: null,
    };
    const companyId = (await systemDb().company.findFirstOrThrow({ where: { accountId: r.account.id } })).id;
    return { actor, companyId };
  };

  it("a domain change puts the store back in the safe modes (audited), even by an admin", async () => {
    const id = await newStore("modes", "MO1");
    await accountDb(accountId).store.update({
      where: { id },
      data: { writeBackMode: "LIVE", inventoryPushMode: "LIVE", connectionStatus: connected },
    });
    // Same shop: the modes stay.
    await updateStoreDetails(admin, id, await details(id, { name: "Renamed" }));
    expect(await getStore(owner, id)).toMatchObject({ writeBackMode: "LIVE", inventoryPushMode: "LIVE" });
    const r = await updateStoreDetails(admin, id, await details(id, { domain: dom("modes2") }));
    expect(r.domainChanged).toBe(true);
    expect(await getStore(owner, id)).toMatchObject({
      writeBackMode: "READ_ONLY",
      inventoryPushMode: "DISABLED",
      domain: dom("modes2"),
    });
    const audit = await accountDb(accountId).auditLog.findFirstOrThrow({
      where: { entityId: id, action: "store.details" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.before).toMatchObject({
      writeBackMode: "LIVE",
      inventoryPushMode: "LIVE",
      domain: dom("modes"),
    });
    expect(audit.after).toMatchObject({
      writeBackMode: "READ_ONLY",
      inventoryPushMode: "DISABLED",
      domain: dom("modes2"),
    });
  });

  it("a domain change drops the old shop's queued events and removes our webhooks there", async () => {
    const id = await newStore("dom", "DO1");
    const db = accountDb(accountId);
    await db.store.update({
      where: { id },
      data: { connectionStatus: connected, webhookStatus: { ok: true, topics: ["ORDERS_CREATE"] } },
    });
    // Shop A's orders/create arrived and is still waiting in the queue (no order imported yet).
    const body = JSON.stringify({ admin_graphql_api_id: "gid://shopify/Order/501" });
    const received = await receiveShopifyWebhook(
      body,
      new Headers({
        "x-shopify-shop-domain": dom("dom"),
        "x-shopify-topic": "orders/create",
        "x-shopify-webhook-id": `wh-dom-${tag}`,
        "x-shopify-hmac-sha256": createHmac("sha256", SECRET).update(body).digest("base64"),
      }),
    );
    expect(received).toMatchObject({ status: 200, duplicate: false });
    const eventId = (received as { eventId: string }).eventId;
    expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: eventId } })).headers).toMatchObject({
      shopDomain: dom("dom"),
    });
    // Stored by older code (no shopDomain header) and failed once: dropped too.
    const legacy = await db.webhookEvent.create({
      data: {
        accountId,
        source: "SHOPIFY",
        dedupeKey: `${id}:wh-dom-legacy-${tag}`,
        topic: "orders/create",
        headers: { storeId: id },
        payload: { admin_graphql_api_id: "gid://shopify/Order/502" },
        status: "FAILED",
      },
    });

    const r = await updateStoreDetails(owner, id, await details(id, { domain: dom("dom-b") }));
    expect(r.oldShopWebhooks).toBe(dom("dom"));
    for (const e of [eventId, legacy.id]) {
      expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: e } })).toMatchObject({
        status: "IGNORED",
      });
      // The worker does nothing for it (a Shopify call would throw: no fake given).
      expect(await processShopifyWebhook(accountId, e)).toBe("IGNORED");
    }
    // An event of shop A stored after the change (e.g. intake racing the edit) is ignored by the worker as well.
    const late = await db.webhookEvent.create({
      data: {
        accountId,
        source: "SHOPIFY",
        dedupeKey: `${id}:wh-dom-late-${tag}`,
        topic: "orders/create",
        headers: { storeId: id, shopDomain: dom("dom") },
        payload: { admin_graphql_api_id: "gid://shopify/Order/503" },
      },
    });
    expect(await processShopifyWebhook(accountId, late.id)).toBe("IGNORED");
    expect(await db.order.count({ where: { storeId: id } })).toBe(0);
    // Shop A can no longer reach the store.
    const again = JSON.stringify({ admin_graphql_api_id: "gid://shopify/Order/504" });
    expect(
      await receiveShopifyWebhook(
        again,
        new Headers({
          "x-shopify-shop-domain": dom("dom"),
          "x-shopify-topic": "orders/create",
          "x-shopify-webhook-id": `wh-dom-2-${tag}`,
          "x-shopify-hmac-sha256": createHmac("sha256", SECRET).update(again).digest("base64"),
        }),
      ),
    ).toEqual({ status: 401 });

    // The removal job talks to the OLD shop and leaves the new shop's status alone.
    const fake = okRemoval();
    const job = { accountId, storeId: id, callbackUrl: URI, oldDomain: dom("dom") };
    expect(await runRemoveWebhooks(job, fake.opts)).toBe("removed");
    expect(fake.ops).toEqual(["WebhookSubscriptions", "WebhookDelete"]);
    expect(new Set(fake.hosts)).toEqual(new Set([dom("dom")]));
    expect((await getStore(owner, id)).webhookStatus).toEqual({});
    // Pointed back at shop A before the job ran: nothing is removed (the registration owns them again).
    await updateStoreDetails(owner, id, await details(id, { domain: dom("dom") }));
    expect(await runRemoveWebhooks(job, fakeShopify({}).opts)).toBe("skipped");
  });

  it("the purge after a webhook removal follows the store's current state, not the job payload", async () => {
    const withHooks = { connectionStatus: connected, webhookStatus: { ok: true, topics: ["ORDERS_CREATE"] } };
    // delete (pending) → restore → archive: a delete-era job must not purge the merely archived store.
    const a = await newStore("dra", "DR1");
    await accountDb(accountId).store.update({ where: { id: a }, data: withHooks });
    expect(await deleteStore(owner, a, { confirmCode: "DR1" })).toEqual({ pending: true });
    await restoreStore(owner, a);
    await accountDb(accountId).store.update({ where: { id: a }, data: withHooks }); // re-registered
    await archiveStore(owner, a);
    const staleJob = { accountId, storeId: a, callbackUrl: URI, deleteAfter: true, userId: owner.userId };
    expect(await runRemoveWebhooks(staleJob, okRemoval().opts)).toBe("removed");
    expect(await systemDb().store.count({ where: { id: a } })).toBe(1);
    expect((await getStore(owner, a)).archivedAt).toBeInstanceOf(Date);

    // archive → delete with the delete's job coalesced into the archive's: the store is still deleted.
    const b = await newStore("adl", "AD1");
    await accountDb(accountId).store.update({ where: { id: b }, data: withHooks });
    await archiveStore(owner, b);
    expect(await deleteStore(owner, b, { confirmCode: "AD1" })).toEqual({ pending: true });
    const archiveJob = { accountId, storeId: b, callbackUrl: URI, userId: owner.userId };
    expect(await runRemoveWebhooks(archiveJob, okRemoval().opts)).toBe("deleted");
    expect(await systemDb().store.count({ where: { id: b } })).toBe(0);
  });

  it("webhook intake prefers the live store when an archived one shares the shop and the app secret", async () => {
    const g = await otherGroup("intake");
    const shared = dom("twin");
    // The archived one is created first (so an unordered lookup would usually find it first).
    const archived = await newStore("twin", "TW1");
    await archiveStore(owner, archived);
    const live = await createStore(g.actor, {
      companyId: g.companyId,
      name: "Twin live",
      domain: shared,
      code: "TW2",
      currency: "EUR",
      countries: ["BG"],
      clientId: "client-id-twin-0001",
      clientSecret: SECRET,
    });
    const body = JSON.stringify({ admin_graphql_api_id: "gid://shopify/Order/601" });
    const r = await receiveShopifyWebhook(
      body,
      new Headers({
        "x-shopify-shop-domain": shared,
        "x-shopify-topic": "orders/create",
        "x-shopify-webhook-id": `wh-twin-${tag}`,
        "x-shopify-hmac-sha256": createHmac("sha256", SECRET).update(body).digest("base64"),
      }),
    );
    expect(r).toMatchObject({ status: 200, accountId: g.actor.accountId, duplicate: false });
    expect((r as { ignored?: boolean }).ignored).toBeUndefined();
    expect(
      await accountDb(g.actor.accountId).webhookEvent.count({
        where: { dedupeKey: `${live.id}:wh-twin-${tag}` },
      }),
    ).toBe(1);
  });

  it("subscriptions are kept for a shop shared through the same app only", async () => {
    const g = await otherGroup("apps");
    const mk = async (n: string, code: string, clientId: string) => {
      const id = await newStore(n, code, { clientId });
      await accountDb(accountId).store.update({
        where: { id },
        data: { connectionStatus: connected, webhookStatus: { ok: true, topics: ["ORDERS_CREATE"] } },
      });
      return id;
    };
    // The other group uses the same shop through ANOTHER app: ours are removed.
    const other = await mk("appx", "AX1", "client-id-app-x-0001");
    await createStore(g.actor, {
      companyId: g.companyId,
      name: "Other app",
      domain: dom("appx"),
      code: "AX2",
      currency: "EUR",
      countries: ["BG"],
      clientId: "client-id-app-y-0001",
      clientSecret: "other-app-secret-0001",
    });
    await archiveStore(owner, other);
    const fake = okRemoval();
    expect(await runRemoveWebhooks({ accountId, storeId: other, callbackUrl: URI }, fake.opts)).toBe(
      "removed",
    );
    expect(fake.ops).toEqual(["WebhookSubscriptions", "WebhookDelete"]);

    // The other group uses the same shop through the SAME app: ours stay (they are its subscriptions too).
    const same = await mk("apps", "AS1", "client-id-app-s-0001");
    await createStore(g.actor, {
      companyId: g.companyId,
      name: "Same app",
      domain: dom("apps"),
      code: "AS2",
      currency: "EUR",
      countries: ["BG"],
      clientId: "client-id-app-s-0001",
      clientSecret: SECRET,
    });
    await archiveStore(owner, same);
    const none = fakeShopify({});
    expect(await runRemoveWebhooks({ accountId, storeId: same, callbackUrl: URI }, none.opts)).toBe(
      "removed",
    );
    expect(none.ops).toEqual([]);
    expect((await getStore(owner, same)).webhookStatus).toMatchObject({ removed: true, note: "shared_shop" });
  });

  it("a store edit waits for an order import in flight and then sees its order (code stays locked)", async () => {
    const id = await newStore("race", "RA1");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const insertedP = new Promise<void>((r) => (inserted = r));
    // What importShopifyOrder does: store key shared, then the insert, then the commit (held open here).
    const importing = withAccountTransaction(accountId, async (tx, { lockKeyShared }) => {
      await lockKeyShared(`store:${id}`);
      await tx.order.create({
        data: {
          accountId,
          storeId: id,
          companyId: companyA,
          source: "SHOPIFY",
          number: "RA-1",
          currency: "EUR",
          subtotal: 1,
          total: 1,
          paymentMethod: "COD",
          placedAt: new Date(),
        },
      });
      inserted();
      await gate;
    });
    await insertedP;
    const edit = updateStoreDetails(owner, id, await details(id, { code: "RA2" }));
    await new Promise((r) => setTimeout(r, 200)); // the edit's pre-check passes (order not committed yet)
    release();
    await importing;
    await expect(edit).rejects.toMatchObject({ code: "code_locked" });
    expect((await getStore(owner, id)).code).toBe("RA1");
  });
});
