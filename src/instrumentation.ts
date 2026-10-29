// Next.js instrumentation hook, runs once at server start. Node-only work lives in instrumentation-node.ts
// so the Edge bundle never sees Node APIs.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await (await import("./instrumentation-node")).registerNode();
  }
}
