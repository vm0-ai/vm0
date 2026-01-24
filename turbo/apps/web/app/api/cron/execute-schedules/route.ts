import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { scheduleService } from "../../../../src/lib/schedule";
import { logger } from "../../../../src/lib/logger";

const log = logger("cron:execute-schedules");

/**
 * Cron endpoint that executes due schedules
 * Configured to run every minute via Vercel cron
 */
export async function GET(request: Request) {
  initServices();

  // Verify cron secret (Vercel automatically injects CRON_SECRET into Authorization header)
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    log.warn("Invalid cron secret provided");
    return NextResponse.json(
      { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  log.debug("Executing due schedules...");

  try {
    const result = await scheduleService.executeDueSchedules();

    log.debug(
      `Cron completed: ${result.executed} executed, ${result.skipped} skipped`,
    );

    return NextResponse.json({
      success: true,
      executed: result.executed,
      skipped: result.skipped,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    log.error(`Cron execution failed: ${errorMessage}`);

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
      },
      { status: 500 },
    );
  }
}
