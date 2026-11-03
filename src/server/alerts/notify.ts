import { z } from "zod";
import type { AlertSeverity } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { systemDb } from "@/server/db/client";

type Env = Record<string, string | undefined>;

/**
 * Alert notifications (P4-08) behind a small provider interface. Providers are configured by environment
 * variables only; one that is not configured is disabled and says so in the log — nothing is sent and nothing
 * is recorded, so enabling it later starts with new alerts only. No credentials exist in this repository.
 *
 *   Telegram: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (Bot API sendMessage: chat_id, text).
 *   Email:    ALERT_EMAIL_WEBHOOK_URL (+ optional ALERT_EMAIL_WEBHOOK_TOKEN as a Bearer token) + ALERT_EMAIL_TO:
 *             a JSON POST {to, subject, text} to an HTTP mail relay chosen by the owner (no SMTP dependency).
 *   NOTIFY_MIN_SEVERITY: CRITICAL (default) | WARNING | INFO.
 *
 * Messages carry the alert's title, severity and a link to the CRM — never the alert body (it may hold
 * customer data). Each (alert, channel) is claimed once (unique row) before sending, so an alert is never
 * notified twice on a channel, even with two workers.
 */

export interface AlertMessage {
  alertId: string;
  severity: AlertSeverity;
  title: string;
  link: string | null;
}

export interface NotificationProvider {
  channel: string;
  /** null when configured; otherwise why it is disabled (logged). */
  disabledReason: string | null;
  send(message: AlertMessage): Promise<void>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const text = (m: AlertMessage) => `[${m.severity}] ${m.title}${m.link ? `\n${m.link}` : ""}`.slice(0, 3500);

export function telegramProvider(env: Env = process.env, fetchImpl: FetchLike = fetch) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  return {
    channel: "telegram",
    disabledReason: token && chatId ? null : "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set",
    async send(m: AlertMessage) {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: text(m) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`telegram HTTP ${res.status}`);
    },
  } satisfies NotificationProvider;
}

export function emailProvider(env: Env = process.env, fetchImpl: FetchLike = fetch) {
  const url = env.ALERT_EMAIL_WEBHOOK_URL?.trim();
  const to = env.ALERT_EMAIL_TO?.trim();
  const valid = !!url && /^https:\/\//.test(url) && !!to;
  return {
    channel: "email",
    disabledReason: valid ? null : "ALERT_EMAIL_WEBHOOK_URL (https) / ALERT_EMAIL_TO not set",
    async send(m: AlertMessage) {
      const token = env.ALERT_EMAIL_WEBHOOK_TOKEN?.trim();
      const res = await fetchImpl(url!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ to, subject: `[CRM ${m.severity}] ${m.title}`.slice(0, 200), text: text(m) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`email relay HTTP ${res.status}`);
    },
  } satisfies NotificationProvider;
}

export const providersFromEnv = (env: Env = process.env): NotificationProvider[] => [
  emailProvider(env),
  telegramProvider(env),
];

const RANK: Record<AlertSeverity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };
const MinSeverity = z.enum(["INFO", "WARNING", "CRITICAL"]).catch("CRITICAL");

/** Notifies new open alerts at or above the minimum severity (created in the last 24 h) on every enabled channel. */
export async function dispatchNotifications(
  providers: NotificationProvider[],
  opts: { now?: Date; env?: Env; take?: number } = {},
) {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const min = MinSeverity.parse(env.NOTIFY_MIN_SEVERITY ?? "CRITICAL");
  const enabled = providers.filter((p) => {
    if (p.disabledReason)
      logger.info({ channel: p.channel, reason: p.disabledReason }, "notification channel disabled");
    return !p.disabledReason;
  });
  const result = { sent: 0, failed: 0, disabled: providers.length - enabled.length };
  if (enabled.length === 0) return result;
  const db = systemDb();
  const severities = (Object.keys(RANK) as AlertSeverity[]).filter((s) => RANK[s] >= RANK[min]);
  const base = (env.APP_URL ?? env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, "");
  for (const p of enabled) {
    const due = await db.alert.findMany({
      where: {
        status: "OPEN",
        severity: { in: severities },
        createdAt: { gte: new Date(now.getTime() - 24 * 3600_000) },
        notifications: { none: { channel: p.channel } },
      },
      select: { id: true, accountId: true, severity: true, title: true, entityType: true, entityId: true },
      orderBy: { createdAt: "asc" },
      take: opts.take ?? 50,
    });
    for (const a of due) {
      const claim = await db.alertNotification.createMany({
        data: [{ accountId: a.accountId, alertId: a.id, channel: p.channel }],
        skipDuplicates: true,
      });
      if (claim.count !== 1) continue; // another worker has it
      const link = base
        ? a.entityType === "Order" && a.entityId
          ? `${base}/orders/${a.entityId}`
          : `${base}/alerts`
        : null;
      try {
        await p.send({ alertId: a.id, severity: a.severity, title: a.title, link });
        await db.alertNotification.update({
          where: { alertId_channel: { alertId: a.id, channel: p.channel } },
          data: { status: "SENT", sentAt: new Date() },
        });
        result.sent++;
      } catch (err) {
        const error = scrubText((err as Error).message).slice(0, 500);
        logger.warn({ channel: p.channel, alertId: a.id, err: error }, "alert notification failed");
        await db.alertNotification.update({
          where: { alertId_channel: { alertId: a.id, channel: p.channel } },
          data: { status: "FAILED", error },
        });
        result.failed++;
      }
    }
  }
  return result;
}
