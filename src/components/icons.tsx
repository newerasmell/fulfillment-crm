// Stroke icons (24×24) matching the design concept. Decorative unless a label is given.
const PATHS = {
  home: ["M3 11l9-7 9 7", "M5 10v10h14V10"],
  orders: ["M4 4h16v16H4z", "M4 13h4l2 3h4l2-3h4"],
  truck: [
    "M3 6h11v10H3z",
    "M14 10h4l3 3v3h-7",
    "M7 20a2 2 0 100-4 2 2 0 000 4z",
    "M17 20a2 2 0 100-4 2 2 0 000 4z",
  ],
  returns: ["M9 14L4 9l5-5", "M4 9h11a5 5 0 010 10h-3"],
  ticket: ["M4 5h16v11H8l-4 4z"],
  box: ["M3 7l9-4 9 4-9 4-9-4z", "M3 7v10l9 4 9-4V7", "M12 11v10"],
  inbound: ["M12 3v12", "M7 10l5 5 5-5", "M4 17v3h16v-3"],
  tag: ["M3 12V4h8l10 10-8 8z", "M7.5 9a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"],
  cash: ["M2 6h20v12H2z", "M12 15a3 3 0 100-6 3 3 0 000 6z"],
  invoice: ["M6 3h9l4 4v14H6z", "M9 12h7M9 16h7"],
  chart: ["M4 20V10M10 20V4M16 20v-7M2 20h20"],
  warehouse: ["M3 21V9l9-5 9 5v12", "M7 21v-8h10v8"],
  store: ["M4 9l1-5h14l1 5", "M4 9v11h16V9", "M4 9h16"],
  route: ["M6 3v6a6 6 0 006 6h6", "M15 12l3 3-3 3", "M6 21v-6"],
  sparkle: ["M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"],
  pin: ["M12 21s-7-6-7-11a7 7 0 0114 0c0 5-7 11-7 11z", "M12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"],
  users: [
    "M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2",
    "M9 11a4 4 0 100-8 4 4 0 000 8z",
    "M22 21v-2a4 4 0 00-3-3.9",
    "M16 3.1a4 4 0 010 7.8",
  ],
  key: ["M15 7a4 4 0 11-3.9 4.9L3 20v-3h3v-3h3l1.1-1.1A4 4 0 0115 7z"],
  log: ["M8 6h13M8 12h13M8 18h13", "M3 6h.01M3 12h.01M3 18h.01"],
  cog: [
    "M12 15a3 3 0 100-6 3 3 0 000 6z",
    "M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-2.9-1.2l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.7 1.7 0 003 15H3a2 2 0 010-4h.1a1.7 1.7 0 001.2-2.9l-.1-.1a2 2 0 112.8-2.8l.1.1A1.7 1.7 0 009 4.6V3a2 2 0 014 0v.1a1.7 1.7 0 002.9 1.2l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 001.2 2.9h.1a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z",
  ],
  search: ["M11 18a7 7 0 100-14 7 7 0 000 14z", "M20 20l-3.5-3.5"],
  plus: ["M12 5v14M5 12h14"],
  chevronDown: ["M7 10l5 5 5-5"],
  bell: ["M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 003.4 0"],
  logout: ["M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4", "M16 17l5-5-5-5", "M21 12H9"],
  x: ["M18 6L6 18M6 6l12 12"],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 18,
  label,
  className,
}: {
  name: IconName;
  size?: number;
  label?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
