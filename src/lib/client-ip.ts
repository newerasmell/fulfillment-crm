/**
 * Client IP behind Render's proxy. X-Forwarded-For is a list the client can pre-fill; the proxy appends the
 * address it saw, so the trustworthy entry is counted from the RIGHT: TRUSTED_PROXY_HOPS (default 1) is the
 * number of proxies in front of the app.
 */
export function clientIp(get: (name: string) => string | null): string | null {
  const hops = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS ?? 1) || 1);
  const entries = (get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return entries[entries.length - hops] ?? get("x-real-ip") ?? null;
}
