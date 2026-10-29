// Runs once when the web server starts (Next.js instrumentation hook): refuse to serve traffic with a
// database role that would silently bypass row-level security.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL) return;
  const { assertSafeDatabaseRole } = await import("@/server/db/client");
  await assertSafeDatabaseRole();
}
