import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { processStaleUsageEvents } from "../../../../src/lib/zero/credit/usage-event-service";
import { logger } from "../../../../src/lib/shared/logger";
import { env } from "../../../../src/env";

const log = logger("cron:process-usage-events");

export async function GET(request: Request): Promise<Response> {
  initServices();

  const authHeader = request.headers.get("authorization");
  const cronSecret = env().CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const processed = await processStaleUsageEvents();

  if (processed > 0) {
    log.debug("Usage event processing cron completed", { processed });
  }

  return NextResponse.json({ success: true, processed });
}
