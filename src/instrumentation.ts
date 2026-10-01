/**
 * Next calls register once per server instance, on Node and on the edge.
 * The edge runtime returns before it can start a timer.
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { prisma } = await import("@/lib/db");
  const { assertRuntimeCompatibility } = await import("@/lib/quarter/compatibility");
  await assertRuntimeCompatibility(prisma);
  const { startBreakPickTimer } = await import("@/lib/breaks/auto-pick");
  startBreakPickTimer();
}
