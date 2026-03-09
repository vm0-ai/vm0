import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import {
  drainBatch,
  cleanupExpiredOutbox,
} from "../../../../src/lib/email/outbox-service";
import { logger } from "../../../../src/lib/logger";
import { env } from "../../../../src/env";

const log = logger("cron:drain-email-outbox");

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

  const drained = await drainBatch();
  const cleaned = await cleanupExpiredOutbox();

  if (drained > 0 || cleaned > 0) {
    log.debug("Email outbox cron completed", { drained, cleaned });
  }

  return NextResponse.json({ success: true, drained, cleaned });
}
