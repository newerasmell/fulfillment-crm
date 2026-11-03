/** Warehouse identity chip: colour always next to the name (DESIGN.md principle 3). */
export function ConnectionChip({ type, name }: { type: string; name?: string }) {
  const eu = type === "EUSHIPMENTS";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold ${
        eu ? "bg-eu-chip text-eu-text" : "bg-fhb-chip text-fhb-text"
      }`}
    >
      <span aria-hidden className={`size-2 rounded-full ${eu ? "bg-eu" : "bg-fhb"}`} />
      {name ?? (eu ? "euShipments" : "FHB")}
    </span>
  );
}

export const monoCls = "font-mono text-[13px]";

export function TesterBadge() {
  return (
    <span className="ml-2 rounded-full bg-warn-bg px-2 py-0.5 text-[11px] font-semibold text-warn">
      TESTER
    </span>
  );
}
