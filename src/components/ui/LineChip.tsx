import { lineColor } from "@/server/lines/colors";

/** Product line identity: colour + name, never colour alone (DESIGN.md). */
export function LineChip({
  name,
  color,
  className = "",
}: {
  name: string;
  color: string;
  className?: string;
}) {
  const c = lineColor(color);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${c.chip} ${className}`}
    >
      <span aria-hidden className={`size-1.5 rounded-full ${c.dot}`} />
      {name}
    </span>
  );
}
