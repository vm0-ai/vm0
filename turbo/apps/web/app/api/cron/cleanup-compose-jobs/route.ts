import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { composeJobs } from "../../../../src/db/schema/compose-job";
import { and, eq, lt, inArray } from "drizzle-orm";
import { logger } from "../../../../src/lib/logger";
import { env } from "../../../../src/env";

const log = logger("cron:cleanup-compose-jobs");

// Job retention: 24 hours
const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

interface CleanupResult {
  jobId: string;
  previousStatus: string;
  status: "cleaned" | "error";
  error?: string;
}

export async function GET(request: Request): Promise<Response> {
  initServices();

  // Verify cron secret (Vercel automatically injects CRON_SECRET into Authorization header)
  const authHeader = request.headers.get("authorization");
  const cronSecret = env().CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const now = Date.now();
  const cutoffTime = new Date(now - JOB_RETENTION_MS);

  log.debug(
    `Checking for stale compose jobs older than ${cutoffTime.toISOString()}...`,
  );

  // Find all pending and running jobs created more than 24 hours ago
  const staleJobs = await globalThis.services.db
    .select({
      id: composeJobs.id,
      status: composeJobs.status,
      createdAt: composeJobs.createdAt,
    })
    .from(composeJobs)
    .where(
      and(
        inArray(composeJobs.status, ["pending", "running"]),
        lt(composeJobs.createdAt, cutoffTime),
      ),
    );

  if (staleJobs.length === 0) {
    log.debug("No stale compose jobs found");
    return NextResponse.json({
      cleaned: 0,
      errors: 0,
      results: [],
    });
  }

  log.debug(`Found ${staleJobs.length} stale compose jobs to cleanup`);

  const results: CleanupResult[] = [];

  for (const job of staleJobs) {
    try {
      // Update job status to failed with timeout error
      await globalThis.services.db
        .update(composeJobs)
        .set({
          status: "failed",
          completedAt: new Date(),
          error: "Job timed out (exceeded 24h retention)",
        })
        .where(
          and(
            eq(composeJobs.id, job.id),
            inArray(composeJobs.status, ["pending", "running"]),
          ),
        );

      log.debug(
        `Cleaned up stale compose job ${job.id} (status: ${job.status}, created: ${job.createdAt.toISOString()})`,
      );

      results.push({
        jobId: job.id,
        previousStatus: job.status,
        status: "cleaned",
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      log.error(`Failed to cleanup compose job ${job.id}: ${errorMessage}`);

      results.push({
        jobId: job.id,
        previousStatus: job.status,
        status: "error",
        error: errorMessage,
      });
    }
  }

  return NextResponse.json({
    cleaned: results.filter((r) => r.status === "cleaned").length,
    errors: results.filter((r) => r.status === "error").length,
    results,
  });
}
