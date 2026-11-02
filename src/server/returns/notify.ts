import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { accountDb, systemDb } from "@/server/db/client";
import { emailProvider, telegramProvider, type NotificationProvider } from "@/server/alerts/notify";
import { getReturnsCodSettings } from "./settings";

type Env = Record<string, string | undefined>;

/**
 * "Return received — the refund can be processed" to support (SPEC §6.5), through the existing alert providers
 * (P4-08). Support can have its own address / chat: RETURNS_SUPPORT_EMAIL_TO and RETURNS_SUPPORT_TELEGRAM_CHAT_ID
 * (otherwise ALERT_EMAIL_TO / TELEGRAM_CHAT_ID). A channel that is not configured is off: nothing is sent and
 * nothing is recorded. Each (case, channel) is claimed once (unique row), so support never gets the same
 * return twice on a channel; a FAILED channel is retried only when an operator asks again.
 *
 * Automatic only for returns the warehouse dated within the last AUTO_WINDOW_DAYS (so the first sweep after a
 * deploy does not send the whole history); older ones and undated ones are sent from the board's button.
 * The message carries the order number, the warehouse and a link — no customer data.
 */

export const AUTO_WINDOW_DAYS = 3;

export function supportProviders(env: Env = process.env): NotificationProvider[] {
  const e = {
    ...env,
    ALERT_EMAIL_TO: env.RETURNS_SUPPORT_EMAIL_TO?.trim() || env.ALERT_EMAIL_TO,
    TELEGRAM_CHAT_ID: env.RETURNS_SUPPORT_TELEGRAM_CHAT_ID?.trim() || env.TELEGRAM_CHAT_ID,
  };
  return [emailProvider(e), telegramProvider(e)];
}

export function supportTitle(c: { reference: string; connectionName: string }) {
  return `Върната пратка ${c.reference} е получена в склада (${c.connectionName}) — може да се възстанови сумата / Return received, refund can be processed`;
}

export async function notifySupportForAccount(
  accountId: string,
  providers: NotificationProvider[],
  opts: { now?: Date; env?: Env } = {},
) {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const result = { sent: 0, failed: 0, disabled: 0 };
  const enabled = providers.filter((p) => !p.disabledReason);
  result.disabled = providers.length - enabled.length;
  const db = accountDb(accountId);
  const { notifySupport } = await getReturnsCodSettings(accountId);
  const since = new Date(now.getTime() - AUTO_WINDOW_DAYS * 86_400_000);
  const due = await db.returnCase.findMany({
    where: {
      state: "RECEIVED",
      processedAt: null,
      OR: [
        { supportNotifyRequestedAt: { not: null } },
        ...(notifySupport ? [{ supportNotifiedAt: null, receivedAt: { gte: since } }] : []),
      ],
    },
    select: {
      id: true,
      reference: true,
      supportNotifyRequestedAt: true,
      connection: { select: { name: true } },
      notifications: { select: { channel: true, status: true } },
    },
    take: 100,
    orderBy: { receivedAt: "asc" },
  });
  if (enabled.length === 0) {
    if (due.length)
      logger.info({ accountId, due: due.length }, "support notification: no channel configured (off)");
    // Nothing can be sent; a manual request stays visible as "not sent" on the board.
    if (due.some((c) => c.supportNotifyRequestedAt))
      await db.returnCase.updateMany({
        where: { id: { in: due.filter((c) => c.supportNotifyRequestedAt).map((c) => c.id) } },
        data: { supportNotifyRequestedAt: null },
      });
    return result;
  }
  const base = (env.APP_URL ?? env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, "");
  for (const c of due) {
    const manual = !!c.supportNotifyRequestedAt;
    let anySent = false;
    for (const p of enabled) {
      const prev = c.notifications.find((n) => n.channel === p.channel);
      if (prev?.status === "SENT" || prev?.status === "SENDING") continue;
      if (prev && !manual) continue; // a FAILED channel is retried only on request
      // Claim: insert, or (manual retry) flip FAILED → SENDING; only the winner sends.
      const claimed = prev
        ? (
            await db.returnNotification.updateMany({
              where: { returnCaseId: c.id, channel: p.channel, status: "FAILED" },
              data: { status: "SENDING", error: null },
            })
          ).count
        : (
            await db.returnNotification.createMany({
              data: [{ accountId, returnCaseId: c.id, channel: p.channel }],
              skipDuplicates: true,
            })
          ).count;
      if (claimed !== 1) continue;
      try {
        await p.send({
          alertId: c.id,
          severity: "INFO",
          title: supportTitle({ reference: c.reference, connectionName: c.connection.name }),
          link: base ? `${base}/returns?case=${c.id}` : null,
        });
        await db.returnNotification.update({
          where: { returnCaseId_channel: { returnCaseId: c.id, channel: p.channel } },
          data: { status: "SENT", sentAt: new Date() },
        });
        anySent = true;
        result.sent++;
      } catch (err) {
        const error = scrubText((err as Error).message).slice(0, 500);
        logger.warn({ channel: p.channel, returnCaseId: c.id, err: error }, "support notification failed");
        await db.returnNotification.update({
          where: { returnCaseId_channel: { returnCaseId: c.id, channel: p.channel } },
          data: { status: "FAILED", error },
        });
        result.failed++;
      }
    }
    await db.returnCase.update({
      where: { id: c.id },
      data: {
        supportNotifyRequestedAt: null,
        ...(anySent ? { supportNotifiedAt: now } : {}),
        // Automatic attempt done (even if a channel failed): no automatic retry loop.
        ...(!anySent && !manual ? { supportNotifiedAt: now } : {}),
      },
    });
  }
  return result;
}

/** Worker: every account that has return cases waiting. */
export async function notifySupportAll(providers: NotificationProvider[] = supportProviders()) {
  const accounts = await systemDb().returnCase.findMany({
    where: { state: "RECEIVED", processedAt: null },
    select: { accountId: true },
    distinct: ["accountId"],
  });
  const total = { sent: 0, failed: 0 };
  for (const { accountId } of accounts) {
    const r = await notifySupportForAccount(accountId, providers);
    total.sent += r.sent;
    total.failed += r.failed;
  }
  return total;
}
