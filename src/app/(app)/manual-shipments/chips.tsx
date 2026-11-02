/** Kind of manual shipment, coloured like its warehouse (FHB / euShipments), always with the name. */
export function KindChip({ kind, label }: { kind: string; label: string }) {
  const cls =
    kind === "JOY_LABEL"
      ? "bg-fhb-chip text-fhb-text"
      : kind === "WAREHOUSE"
        ? "bg-accent-soft text-accent-strong"
        : "bg-eu-chip text-eu-text";
  return <span className={`rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${cls}`}>{label}</span>;
}
