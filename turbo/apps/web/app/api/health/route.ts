import { NextResponse } from "next/server";
import { initServices } from "../../../src/lib/init-services";
import { sql } from "drizzle-orm";

/**
 * GET /api/health
 * Health check endpoint that tests database connectivity
 */
export async function GET(): Promise<NextResponse> {
  const startTime = Date.now();

  try {
    const initStart = Date.now();
    initServices();
    const initTime = Date.now() - initStart;

    // Get DATABASE_URL info (redacted)
    const dbUrl = globalThis.services.env.DATABASE_URL;
    const dbHost = dbUrl.split("@")[1]?.split("/")[0] || "unknown";

    // Test database connection with a simple query
    const dbStart = Date.now();
    await globalThis.services.db.execute(sql`SELECT 1 as test`);
    const dbTime = Date.now() - dbStart;

    const totalTime = Date.now() - startTime;

    return NextResponse.json({
      status: "healthy",
      database: "connected",
      initTime: `${initTime}ms`,
      dbQueryTime: `${dbTime}ms`,
      totalTime: `${totalTime}ms`,
      dbHost,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const totalTime = Date.now() - startTime;
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    const errorStack =
      error instanceof Error ? error.stack?.split("\n").slice(0, 5) : undefined;

    return NextResponse.json(
      {
        status: "unhealthy",
        database: "disconnected",
        error: errorMessage,
        errorStack,
        totalTime: `${totalTime}ms`,
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
