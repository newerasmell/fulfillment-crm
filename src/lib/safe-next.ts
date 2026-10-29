/** Only same-site invitation paths may be used as a post-login target (no open redirect). */
export function safeNext(next: unknown): string {
  return typeof next === "string" && /^\/invite\/[A-Za-z0-9_-]{20,100}$/.test(next) ? next : "/";
}
