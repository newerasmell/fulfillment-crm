// Liveness: the process is up. Used by Render's health check (render.yaml healthCheckPath).
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
