/** Справки (P10-04): aggregate, read-only reports. See each module for definitions. */
export const REPORT_KEYS = ["orders", "shipments", "timing", "cod", "review", "stock"] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];
export const isReportKey = (v: unknown): v is ReportKey =>
  typeof v === "string" && (REPORT_KEYS as readonly string[]).includes(v);

export { codCsv, codReport } from "./cod";
export { ordersCsv, ordersReport } from "./orders";
export { parseRange, presetRange, RANGE_PRESETS, sofiaDay, sofiaDayStart, type ReportRange } from "./range";
export { reviewCsv, reviewReport } from "./review";
export { shipmentsCsv, shipmentsReport, rate } from "./shipments";
export { assertReport, type ReportCtx } from "./sql";
export { stockCsv, stockReport } from "./stock";
export { STAGES, timingCsv, timingReport } from "./timing";
