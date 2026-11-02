import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";

/**
 * Reason codes for review decisions (P4-05, SPEC §7.1). Configurable per group: an account without stored codes
 * uses DEFAULT_REASON_CODES; the first change an admin makes stores the defaults and applies the change, so the
 * list a reviewer picks from never jumps. Codes are deactivated, never deleted — old reviews keep their code.
 */

/** The three decisions of the decision bar (Одобри / Задръж / Блокирай). */
export const DECISION_KINDS = ["approve", "hold", "block"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];
/** Every list a code can be offered in: the three decisions + "warehouse" (Изпрати от / Пренасочи, P4-09). */
export const REASON_KINDS = [...DECISION_KINDS, "warehouse"] as const;
export type ReasonKind = (typeof REASON_KINDS)[number];

export interface ReasonCode {
  code: string;
  labelBg: string;
  labelEn: string;
  decisions: ReasonKind[];
  active: boolean;
  sortOrder: number;
}

/** Free text is required with this code. */
export const OTHER_REASON = "other";

const d = (
  code: string,
  labelBg: string,
  labelEn: string,
  decisions: ReasonKind[],
  sortOrder: number,
): ReasonCode => ({ code, labelBg, labelEn, decisions, active: true, sortOrder });

export const DEFAULT_REASON_CODES: readonly ReasonCode[] = [
  d("all_ok", "Всичко е наред", "Everything is fine", ["approve"], 10),
  d("warnings_checked", "Предупрежденията са проверени", "Warnings checked", ["approve"], 20),
  d("address_fixed", "Поправен адрес", "Address corrected", ["approve"], 30),
  d("phone_fixed", "Поправен телефон", "Phone corrected", ["approve"], 40),
  d("customer_confirmed", "Потвърдено с клиента", "Confirmed with the customer", ["approve", "hold"], 50),
  d("contact_customer", "Чака връзка с клиента", "Waiting to reach the customer", ["hold"], 60),
  d("address_unclear", "Неясен адрес", "Unclear address", ["hold", "block"], 70),
  d("waiting_stock", "Чака наличност", "Waiting for stock", ["hold"], 80),
  d("payment_check", "Проверка на плащането", "Payment to be checked", ["hold", "block"], 90),
  d("suspected_fraud", "Съмнение за измама", "Suspected fraud", ["hold", "block"], 100),
  d("duplicate_order", "Дублирана поръчка", "Duplicate order", ["block"], 110),
  d("customer_cancelled", "Клиентът се отказа", "Customer cancelled", ["block"], 120),
  d("undeliverable", "Не може да се достави", "Cannot be delivered", ["block"], 130),
  d("test_order", "Тестова поръчка", "Test order", ["block"], 140),
  // Warehouse choice / reroute (P4-09).
  d("no_stock", "Няма наличност", "No stock", ["warehouse"], 200),
  d("faster_delivery", "По-бърза доставка", "Faster delivery", ["warehouse"], 210),
  d("customer_requested", "Клиентът поиска", "The customer asked for it", ["warehouse"], 220),
  d(OTHER_REASON, "Друго (опишете)", "Other (describe)", ["approve", "hold", "block", "warehouse"], 1000),
];

const asKinds = (v: string[]) =>
  v.filter((k): k is ReasonKind => (REASON_KINDS as readonly string[]).includes(k));

/** The group's reason codes (stored ones, or the defaults), ordered for display. */
export async function listReasonCodes(
  accountId: string,
  opts: { includeInactive?: boolean } = {},
): Promise<ReasonCode[]> {
  const rows = await accountDb(accountId).reviewReasonCode.findMany({
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
  });
  const all = rows.length
    ? rows.map((r) => ({
        code: r.code,
        labelBg: r.labelBg,
        labelEn: r.labelEn,
        decisions: asKinds(r.decisions),
        active: r.active,
        sortOrder: r.sortOrder,
      }))
    : DEFAULT_REASON_CODES.map((r) => ({ ...r, decisions: [...r.decisions] }));
  return opts.includeInactive ? all : all.filter((r) => r.active);
}

/** Codes a reviewer may pick for one decision. */
export const codesFor = (codes: readonly ReasonCode[], kind: ReasonKind) =>
  codes.filter((c) => c.active && c.decisions.includes(kind));

export const ReasonCodeInput = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]{1,39}$/),
  labelBg: z.string().trim().min(1).max(80),
  labelEn: z.string().trim().min(1).max(80),
  decisions: z.array(z.enum(REASON_KINDS)).min(1),
  sortOrder: z.coerce.number().int().min(0).max(100_000).optional(),
});
export type ReasonCodeInput = z.input<typeof ReasonCodeInput>;

type Tx = Parameters<Parameters<typeof withAccountTransaction>[1]>[0];

/** Stores the defaults the first time an account changes its list (inside the caller's transaction). */
async function materialiseDefaults(tx: Tx, accountId: string) {
  if ((await tx.reviewReasonCode.count()) > 0) return;
  await tx.reviewReasonCode.createMany({
    data: DEFAULT_REASON_CODES.map((r) => ({ ...r, decisions: [...r.decisions], accountId })),
    skipDuplicates: true,
  });
}

/** Adds a code or updates its labels / decisions / position (OWNER, ADMIN). */
export async function saveReasonCode(actor: ScopedActor, raw: ReasonCodeInput) {
  assertCan(actor.role, "reviews.reasonCodes");
  const input = ReasonCodeInput.parse(raw);
  const saved = await withAccountTransaction(actor.accountId, async (tx) => {
    await materialiseDefaults(tx, actor.accountId);
    const before = await tx.reviewReasonCode.findUnique({
      where: { accountId_code: { accountId: actor.accountId, code: input.code } },
    });
    const sortOrder = input.sortOrder ?? before?.sortOrder ?? 500;
    const data = {
      labelBg: input.labelBg,
      labelEn: input.labelEn,
      decisions: input.decisions,
      sortOrder,
    };
    const row = await tx.reviewReasonCode.upsert({
      where: { accountId_code: { accountId: actor.accountId, code: input.code } },
      create: { accountId: actor.accountId, code: input.code, ...data },
      update: data,
    });
    return { before, row };
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: saved.before ? "review.reason_updated" : "review.reason_created",
    entityType: "ReviewReasonCode",
    entityId: saved.row.id,
    before: saved.before,
    after: saved.row,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return saved.row;
}

/** Turns a code on or off for new decisions (OWNER, ADMIN). "other" always stays available. */
export async function setReasonCodeActive(actor: ScopedActor, code: string, active: boolean) {
  assertCan(actor.role, "reviews.reasonCodes");
  if (code === OTHER_REASON && !active) throw new DomainError("reason_other_required");
  const row = await withAccountTransaction(actor.accountId, async (tx) => {
    await materialiseDefaults(tx, actor.accountId);
    const found = await tx.reviewReasonCode.findUnique({
      where: { accountId_code: { accountId: actor.accountId, code } },
    });
    if (!found) throw new DomainError("not_found");
    return tx.reviewReasonCode.update({ where: { id: found.id }, data: { active } });
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: active ? "review.reason_activated" : "review.reason_deactivated",
    entityType: "ReviewReasonCode",
    entityId: row.id,
    after: { code, active },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return row;
}
