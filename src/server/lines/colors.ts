/**
 * Product line colours (docs/DESIGN.md tokens, `--color-pl-*` in globals.css). They never reuse a status
 * (ok/warn/block) or warehouse (FHB/euShipments) colour and are always shown next to the line name.
 * Class strings are spelled out in full so Tailwind generates them.
 */
export const LINE_COLORS = {
  rose: { band: "bg-pl-rose", chip: "bg-pl-rose-chip text-pl-rose", dot: "bg-pl-rose" },
  slate: { band: "bg-pl-slate", chip: "bg-pl-slate-chip text-pl-slate", dot: "bg-pl-slate" },
  brown: { band: "bg-pl-brown", chip: "bg-pl-brown-chip text-pl-brown", dot: "bg-pl-brown" },
  olive: { band: "bg-pl-olive", chip: "bg-pl-olive-chip text-pl-olive", dot: "bg-pl-olive" },
  ink: { band: "bg-pl-ink", chip: "bg-pl-ink-chip text-pl-ink", dot: "bg-pl-ink" },
} as const;
export type LineColor = keyof typeof LINE_COLORS;
export const LINE_COLOR_KEYS = Object.keys(LINE_COLORS) as LineColor[];

export const isLineColor = (v: unknown): v is LineColor =>
  typeof v === "string" && (LINE_COLOR_KEYS as string[]).includes(v);

/** Unknown or legacy values (the column default) fall back to the first token. */
export const lineColor = (v: string | null | undefined) => LINE_COLORS[isLineColor(v) ? v : "rose"];
