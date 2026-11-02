import { beforeAll, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/server/auth/rbac";
import { systemDb } from "@/server/db/client";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import {
  alertCounts,
  alertHistory,
  assignAlert,
  categoryOf,
  dispatchNotifications,
  emailProvider,
  listOpenAlerts,
  resolveAlert,
  stuckHours,
  sweepOrderAlerts,
  telegramProvider,
  type AlertMessage,
  type NotificationProvider,
} from "./index";

// Synthetic data; notifications go to fake providers / a mocked fetch only.

describe("categories and settings (pure)", () => {
  it("maps the kinds the other modules write", () => {
    expect(categoryOf("outbox_uncertain")).toBe("uncertain");
    expect(categoryOf("shopify_writeback_uncertain")).toBe("uncertain");
    expect(categoryOf("eushipments_stuck_accepted")).toBe("stuck");
    expect(categoryOf("fhb_unknown_status")).toBe("unknown");
    expect(categoryOf("shopify_import_failed")).toBe("import_failed");
    expect(categoryOf("shopify_changed_after_approval")).toBe("shopify_changed");
    expect(categoryOf("shopify_cancelled_after_approval")).toBe("shopify_changed");
    expect(categoryOf("eushipments_submit_failed")).toBe("submit_failed");
    expect(categoryOf("fhb_order_rejected")).toBe("submit_failed");
    expect(categoryOf("order_blocked")).toBe("blocked");
    expect(categoryOf("api.spec_change")).toBe("other");
  });
  it("stuck thresholds can be overridden by env, bad values are ignored", () => {
    expect(stuckHours({ ALERT_STUCK_HOURS: '{"QUEUED": 1}' }).QUEUED).toBe(1);
    expect(stuckHours({ ALERT_STUCK_HOURS: "nonsense" }).QUEUED).toBe(4);
  });
  it("providers are disabled without env and never call out", async () => {
    const fetchImpl = vi.fn();
    expect(telegramProvider({}, fetchImpl).disabledReason).toMatch(/TELEGRAM/);
    expect(
      emailProvider({ ALERT_EMAIL_WEBHOOK_URL: "http://plain.example" }, fetchImpl).disabledReason,
    ).toMatch(/https/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("telegram sends chat_id + text (title and link only)", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const p = telegramProvider({ TELEGRAM_BOT_TOKEN: "test-bot-token", TELEGRAM_CHAT_ID: "-100" }, fetchImpl);
    await p.send({ alertId: "a", severity: "CRITICAL", title: "T", link: "https://crm.example/alerts" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bottest-bot-token/sendMessage");
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: "-100",
      text: "[CRITICAL] T\nhttps://crm.example/alerts",
    });
  });
});

describe("alerts and tasks (DB)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  let n = 8000;
  const db = () => systemDb();
  const order = async (status: "BLOCKED" | "QUEUED" | "UNKNOWN" | "APPROVED") => {
    const { order } = await euTestOrder(g, { number: `#${++n}` });
    await db().order.update({ where: { id: order.id }, data: { status } });
    return order;
  };

  beforeAll(async () => {
    g = await euTestGroup("alerts");
  });

  it("the sweep raises one alert per blocked / unknown / stuck order and resolves it once the order moves on", async () => {
    const blocked = await order("BLOCKED");
    const unknown = await order("UNKNOWN");
    const queued = await order("QUEUED");
    const later = new Date(Date.now() + 5 * 3600_000); // QUEUED for > 4 h by then
    await sweepOrderAlerts(later);
    await sweepOrderAlerts(later); // idempotent
    const kinds = async (id: string) =>
      (await db().alert.findMany({ where: { entityId: id, status: { not: "RESOLVED" } } })).map(
        (a) => a.kind,
      );
    expect(await kinds(blocked.id)).toEqual(["order_blocked"]);
    expect(await kinds(unknown.id)).toEqual(["order_unknown"]);
    expect(await kinds(queued.id)).toEqual(["order_stuck"]);

    await db().order.update({ where: { id: blocked.id }, data: { status: "PROCESSING" } });
    const r = await sweepOrderAlerts(later);
    expect(r.resolved).toBeGreaterThanOrEqual(1);
    expect(await kinds(blocked.id)).toEqual([]);
    const alert = await db().alert.findFirstOrThrow({ where: { entityId: blocked.id } });
    expect((await alertHistory(g.owner, alert.id)).map((h) => h.action)).toEqual(["auto_resolve"]);
  });

  it("one list with categories and counts; assign and resolve with a note; scope respected", async () => {
    const o = await order("APPROVED");
    const alert = await db().alert.create({
      data: {
        accountId: g.accountId,
        kind: "shopify_changed_after_approval",
        isTask: true,
        title: "Order changed in Shopify after approval",
        entityType: "Order",
        entityId: o.id,
      },
    });
    const list = await listOpenAlerts(g.owner, { category: "shopify_changed" });
    expect(list.map((a) => a.id)).toContain(alert.id);
    expect(list.find((a) => a.id === alert.id)?.order).toEqual({ id: o.id, number: o.number });
    const counts = await alertCounts(g.owner);
    expect(counts.byCategory.shopify_changed).toBeGreaterThanOrEqual(1);
    expect(counts.total).toBeGreaterThanOrEqual(counts.tasks);

    // Restricted members see only their companies' alerts and cannot act on others.
    const outsider = { ...g.owner, role: "OPERATOR" as const, companyScope: ["another-company"] };
    expect((await listOpenAlerts(outsider)).map((a) => a.id)).not.toContain(alert.id);
    await expect(resolveAlert(outsider, alert.id, "done")).rejects.toMatchObject({ code: "not_found" });
    await expect(resolveAlert({ ...g.owner, role: "VIEWER" }, alert.id, "done")).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    await assignAlert(g.owner, alert.id, g.owner.userId);
    expect((await alertCounts(g.owner)).mine).toBeGreaterThanOrEqual(1);
    await expect(assignAlert(g.owner, alert.id, "not-a-member")).rejects.toMatchObject({
      code: "not_a_member",
    });
    await expect(resolveAlert(g.owner, alert.id, " ")).rejects.toThrow();
    await resolveAlert(g.owner, alert.id, "Checked with the customer, address confirmed");
    await expect(resolveAlert(g.owner, alert.id, "again")).rejects.toMatchObject({ code: "alert_resolved" });
    const history = await alertHistory(g.owner, alert.id);
    expect(history.map((h) => [h.action, h.note])).toEqual([
      ["assign", g.owner.userId],
      ["resolve", "Checked with the customer, address confirmed"],
    ]);
    expect((await listOpenAlerts(g.owner)).map((a) => a.id)).not.toContain(alert.id);
    const audit = await db().auditLog.findMany({
      where: { entityId: alert.id },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((a) => a.action)).toEqual(["alert.assign", "alert.resolve"]);
  });

  it("a note cannot point at another account's alert (DB trigger)", async () => {
    const other = await euTestGroup("alerts-other");
    const foreign = await db().alert.create({ data: { accountId: other.accountId, kind: "x", title: "x" } });
    await expect(
      db().alertNote.create({ data: { accountId: g.accountId, alertId: foreign.id, action: "note" } }),
    ).rejects.toThrow();
  });

  it("notifications: once per alert and channel, CRITICAL by default, failures recorded, disabled channels skipped", async () => {
    const critical = await db().alert.create({
      data: {
        accountId: g.accountId,
        kind: "outbox_uncertain",
        severity: "CRITICAL",
        title: "Unknown result X",
      },
    });
    const warning = await db().alert.create({
      data: { accountId: g.accountId, kind: "order_stuck", severity: "WARNING", title: "Stuck Y" },
    });
    const sent: AlertMessage[] = [];
    const fake: NotificationProvider = {
      channel: "fake",
      disabledReason: null,
      send: async (m) => void sent.push(m),
    };
    const broken: NotificationProvider = {
      channel: "broken",
      disabledReason: null,
      send: async () => {
        throw new Error("relay down");
      },
    };
    const off: NotificationProvider = { channel: "off", disabledReason: "not configured", send: vi.fn() };
    const env = { APP_URL: "https://crm.example.test" };
    const r1 = await dispatchNotifications([fake, broken, off], { env, take: 500 });
    expect(r1.disabled).toBe(1);
    expect(sent.map((m) => m.alertId)).toContain(critical.id);
    expect(sent.map((m) => m.alertId)).not.toContain(warning.id);
    expect(sent.find((m) => m.alertId === critical.id)).toEqual({
      alertId: critical.id,
      severity: "CRITICAL",
      title: "Unknown result X",
      link: "https://crm.example.test/alerts",
    });
    expect(off.send).not.toHaveBeenCalled();
    const count = sent.length;
    await dispatchNotifications([fake, broken], { env, take: 500 });
    expect(sent.length).toBe(count); // never twice
    const failed = await db().alertNotification.findUnique({
      where: { alertId_channel: { alertId: critical.id, channel: "broken" } },
    });
    expect(failed).toMatchObject({ status: "FAILED", error: "relay down" });
    // WARNING and above when configured so.
    await dispatchNotifications([fake], { env: { ...env, NOTIFY_MIN_SEVERITY: "WARNING" }, take: 500 });
    expect(sent.map((m) => m.alertId)).toContain(warning.id);
  });
});
