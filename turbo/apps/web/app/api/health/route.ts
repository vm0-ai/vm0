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
    initServices();

    // Test database connection with a simple query
    const dbStart = Date.now();
    const result = await globalThis.services.db.execute(sql`SELECT 1 as test`);
    const dbTime = Date.now() - dbStart;

    const totalTime = Date.now() - startTime;

    return NextResponse.json({
      status: "healthy",
      database: "connected",
      dbQueryTime: `${dbTime}ms`,
      totalTime: `${totalTime}ms`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const totalTime = Date.now() - startTime;
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      {
        status: "unhealthy",
        database: "disconnected",
        error: errorMessage,
        totalTime: `${totalTime}ms`,
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
