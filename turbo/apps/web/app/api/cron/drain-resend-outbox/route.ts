import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import {
  drainBatch,
  cleanupExpiredOutbox,
} from "../../../../src/lib/zero/email/contact-outbox-service";
import { logger } from "../../../../src/lib/shared/logger";
import { env } from "../../../../src/env";

const log = logger("cron:drain-resend-outbox");

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

  // Short-circuit when contact sync is not configured for this environment.
  if (!env().RESEND_CONTACT_SEGMENT_ID) {
    return NextResponse.json({ success: true, drained: 0, cleaned: 0 });
  }

  const drained = await drainBatch();
  const cleaned = await cleanupExpiredOutbox();

  if (drained > 0 || cleaned > 0) {
    log.debug("Resend contact outbox cron completed", { drained, cleaned });
  }

  return NextResponse.json({ success: true, drained, cleaned });
}
