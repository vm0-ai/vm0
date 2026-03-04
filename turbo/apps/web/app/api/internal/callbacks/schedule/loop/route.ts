import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../../src/lib/callback";
import { agentSchedules } from "../../../../../../src/db/schema/agent-schedule";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("callback:schedule:loop");

// Auto-disable after this many consecutive failures
const MAX_CONSECUTIVE_FAILURES = 3;

interface CallbackPayload {
  scheduleId: string;
  intervalSeconds: number;
}

function parsePayload(payload: unknown): CallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.scheduleId !== "string" ||
    typeof p.intervalSeconds !== "number"
  ) {
    return null;
  }
  return p as unknown as CallbackPayload;
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyCallback<CallbackPayload>(request, log);
  if (!result.ok) return result.response;

  const { status, payload: rawPayload } = result.data;

  const payload = parsePayload(rawPayload);
  if (!payload) {
    return errorResponse("Invalid or missing payload", 400);
  }

  const { scheduleId, intervalSeconds } = payload;

  log.debug("Processing loop schedule callback", {
    runId: result.data.runId,
    status,
    scheduleId,
  });

  // Load schedule
  const [schedule] = await globalThis.services.db
    .select()
    .from(agentSchedules)
    .where(eq(agentSchedules.id, scheduleId))
    .limit(1);

  if (!schedule) {
    // Schedule deleted — gracefully ignore
    log.debug("Schedule not found, ignoring callback", { scheduleId });
    return NextResponse.json({ success: true, skipped: true });
  }

  if (!schedule.enabled) {
    // Schedule disabled — don't advance
    log.debug("Schedule disabled, ignoring callback", { scheduleId });
    return NextResponse.json({ success: true, skipped: true });
  }

  const now = new Date();
  const newFailureCount =
    status === "completed" ? 0 : schedule.consecutiveFailures + 1;
  const shouldDisable = newFailureCount >= MAX_CONSECUTIVE_FAILURES;
  const nextRunAt = shouldDisable
    ? null
    : new Date(now.getTime() + intervalSeconds * 1000);

  await globalThis.services.db
    .update(agentSchedules)
    .set({
      consecutiveFailures: newFailureCount,
      ...(shouldDisable && { enabled: false }),
      nextRunAt,
      updatedAt: now,
    })
    .where(eq(agentSchedules.id, scheduleId));

  if (shouldDisable) {
    log.warn("Loop schedule auto-disabled after consecutive failures", {
      scheduleId,
      scheduleName: schedule.name,
      consecutiveFailures: newFailureCount,
    });
  } else {
    log.info(`Loop schedule advanced after ${status}`, {
      scheduleId,
      scheduleName: schedule.name,
      consecutiveFailures: newFailureCount,
      nextRunAt: nextRunAt?.toISOString(),
    });
  }

  return NextResponse.json({ success: true });
}
