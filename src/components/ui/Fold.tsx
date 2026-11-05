import { ChevronDownIcon } from "./icons";

/** A card that starts folded: title (+ a short count / hint) and a chevron; the body opens on click. */
export function Fold({
  title,
  hint,
  open = false,
  children,
  testId,
}: {
  title: string;
  hint?: React.ReactNode;
  open?: boolean;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <details
      className="group rounded-[var(--radius-card)] border border-line bg-surface"
      open={open}
      data-testid={testId}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 flex-wrap items-baseline gap-2">
          <span className="text-base font-semibold">{title}</span>
          {hint != null && <span className="text-sm text-muted">{hint}</span>}
        </span>
        <span className="text-muted transition-transform group-open:rotate-180">
          <ChevronDownIcon className="h-5 w-5" />
        </span>
      </summary>
      <div className="px-5 pb-5">{children}</div>
    </details>
  );
}

/** One labelled field: the label (bold, black) and the value below it. */
export function Field({
  label,
  children,
  wide = false,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
  testId?: string;
}) {
  return (
    <div className={`min-w-0 ${wide ? "col-span-full" : ""}`} data-testid={testId}>
      <div className="mb-0.5 text-[13px] font-bold text-black">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** The responsive grid of Fields (2+ columns where there is room, 1 on a phone). */
export const fieldGridCls = "grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-6 gap-y-3.5";
