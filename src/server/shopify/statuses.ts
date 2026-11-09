import type { CrmOrderStatus } from "@/generated/prisma/client";

/**
 * CRM-side states before anything was sent to a warehouse: Shopify changes apply directly. BLOCKED is NOT here —
 * it is reported by the vendor for an order it already holds (SPEC §5, INTEGRATION_NOTES status map).
 * ON_HOLD is the CRM's own pre-approval hold (test orders, operator hold).
 */
export const PRE_APPROVAL = new Set<CrmOrderStatus>([
  "IMPORTED",
  "CHECKING",
  "NEEDS_REVIEW",
  "READY",
  "ON_HOLD",
  "AWAITING_TAG",
]);
