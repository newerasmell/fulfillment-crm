/** Small stroke icons for icon buttons (inline SVG, currentColor). */

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export const PencilIcon = ({ className = "h-4 w-4" }: { className?: string }) => (
  <svg {...base} className={className}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

export const RefreshIcon = ({ className = "h-4 w-4" }: { className?: string }) => (
  <svg {...base} className={className}>
    <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
    <path d="M21 3v5h-5" />
  </svg>
);

export const UndoIcon = ({ className = "h-4 w-4" }: { className?: string }) => (
  <svg {...base} className={className}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

export const CopyIcon = ({ className = "h-3.5 w-3.5" }: { className?: string }) => (
  <svg {...base} className={className}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

export const ChevronDownIcon = ({ className = "h-4 w-4" }: { className?: string }) => (
  <svg {...base} className={className}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

/** A square, quiet icon button (pencil / refresh / undo in card headers and rows). */
export const iconButtonCls =
  "inline-grid h-8 w-8 shrink-0 place-items-center rounded-[8px] border border-transparent text-muted hover:border-line hover:bg-hover hover:text-ink disabled:opacity-50";
