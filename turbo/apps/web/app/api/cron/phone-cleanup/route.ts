import { NextResponse } from "next/server";
import { lt } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { logger } from "../../../../src/lib/shared/logger";
import { env } from "../../../../src/env";
import { pendingOutboundCalls } from "../../../../src/db/schema/pending-outbound-call";

const log = logger("cron:phone-cleanup");

// Pending outbound call rows older than this threshold are considered orphaned
// (i.e. the call_ended webhook was never delivered) and should be removed.
const PENDING_CALL_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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

  const cutoff = new Date(Date.now() - PENDING_CALL_TTL_MS);

  const deleted = await globalThis.services.db
    .delete(pendingOutboundCalls)
    .where(lt(pendingOutboundCalls.createdAt, cutoff))
    .returning({ callId: pendingOutboundCalls.callId });

  if (deleted.length > 0) {
    log.info("Cleaned up orphaned pending outbound calls", {
      count: deleted.length,
    });
  }

  return NextResponse.json({ success: true, cleaned: deleted.length });
}
