import { DomainError } from "@/server/accounts";
import {
  DEFAULT_REASON_CODES,
  listReasonCodes,
  OTHER_REASON,
  type ReasonCode,
} from "@/server/review/reasons";

/**
 * Reason codes for "Изпрати от" and "Пренасочи" (P4-09): the group's review reason codes offered for "warehouse"
 * (configurable in Прегледи → Причини, like every other code). A group whose stored list predates this feature (no
 * code offered for "warehouse" at all) gets the defaults: няма наличност, по-бърза доставка, клиентът поиска, друго.
 * "Друго" (other) is always accepted and needs a text.
 */
export async function warehouseReasonCodes(accountId: string): Promise<ReasonCode[]> {
  const all = await listReasonCodes(accountId, { includeInactive: true });
  const configured = all.some((c) => c.decisions.includes("warehouse"));
  const list = configured
    ? all.filter((c) => c.active && c.decisions.includes("warehouse"))
    : DEFAULT_REASON_CODES.filter((c) => c.decisions.includes("warehouse")).map((c) => ({
        ...c,
        decisions: [...c.decisions],
      }));
  if (!list.some((c) => c.code === OTHER_REASON)) {
    const other = DEFAULT_REASON_CODES.find((c) => c.code === OTHER_REASON)!;
    list.push({ ...other, decisions: [...other.decisions] });
  }
  return list.sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
}

/** Checks a reason against the group's list; returns the stored pair. */
export async function assertWarehouseReason(
  accountId: string,
  reasonCode: string | null | undefined,
  reasonText: string | null | undefined,
) {
  const code = reasonCode?.trim() || null;
  const text = reasonText?.trim() || null;
  if (!code) throw new DomainError("reason_required");
  const codes = await warehouseReasonCodes(accountId);
  if (!codes.some((c) => c.code === code)) throw new DomainError("reason_invalid");
  if (code === OTHER_REASON && !text) throw new DomainError("reason_text_required");
  return { reasonCode: code, reasonText: text?.slice(0, 1000) ?? null };
}
