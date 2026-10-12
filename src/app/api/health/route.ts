/**
 * Public health/uptime probe — the only unauthenticated API route (the
 * proxy matcher excludes it). Pings the database so a dead pooler is
 * distinguishable from a dead app; answers are fixed words so nothing
 * about the failure leaks to anonymous callers.
 */
import { getDb } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Plain string keeps the eslint layering rule happy: src/app must not
    // import drizzle-orm directly.
    await getDb().execute("select 1");
    return Response.json(
      { status: "ok" },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    // Server log keeps the cause; the response body never does.
    console.error(
      JSON.stringify({
        level: "error",
        event: "health_check_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
