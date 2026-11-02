/** Inbound status: our Bulgarian name with the raw vendor value next to it (never colour only). */
const KNOWN = [
  "QUEUED",
  "SUBMIT_FAILED",
  "UNCERTAIN",
  "FAILED",
  "CREATED",
  "RECEIVED",
  "CLOSED",
  "DELETED",
  "created",
  "deleted",
];

export function StatusText({ status, t }: { status: string; t: (k: string) => string }) {
  const tone =
    status === "SUBMIT_FAILED" || status === "FAILED" || status === "UNCERTAIN"
      ? "text-block"
      : status === "CLOSED"
        ? "text-ok"
        : "";
  return (
    <span className={tone}>
      {KNOWN.includes(status) ? t(`st.${status}`) : status}
      <span className="ml-1 font-mono text-[11px] text-label">{status}</span>
    </span>
  );
}
