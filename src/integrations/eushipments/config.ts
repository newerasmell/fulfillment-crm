/**
 * euShipments (inout.bg) API — docs/integrations/eushipments.md, INTEGRATION_NOTES §4.
 * Production only (CLAUDE.md): no vendor sandbox is used. Validate-only writes use `testMode: true`.
 */
export const EUSHIPMENTS_BASE_URL = "https://api1.inout.bg/api/v1";

/** Well below the outbox STALE_SENDING_MS (10 min): a hung call must end before the sweep declares it lost. */
export const EUSHIPMENTS_TIMEOUT_MS = 30_000;

/** orders-history accepts 1–100 references per call (spec "Orders_History_Web_Service-v1.0"). */
export const ORDERS_HISTORY_BATCH = 100;
