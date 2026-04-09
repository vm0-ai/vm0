import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../../src/lib/infra/callback";
import { zeroAgentSchedules } from "../../../../../../src/db/schema/zero-agent-schedule";
import type { ScheduleCronCallbackPayload } from "../../../../../../src/lib/infra/callback/callback-payloads";
import { calculateNextRun } from "../../../../../../src/lib/zero/schedule/schedule-service";
import { logger } from "../../../../../../src/lib/shared/logger";

const log = logger("callback:schedule:cron");

// Auto-disable after this many consecutive failures
const MAX_CONSECUTIVE_FAILURES = 3;

function parsePayload(payload: unknown): ScheduleCronCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.scheduleId !== "string" ||
    typeof p.cronExpression !== "string" ||
    typeof p.timezone !== "string"
  ) {
    return null;
  }
  return p as unknown as ScheduleCronCallbackPayload;
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyCallback<ScheduleCronCallbackPayload>(
    request,
    log,
  );
  if (!result.ok) return result.response;

  const { status, payload: rawPayload } = result.data;

  const payload = parsePayload(rawPayload);
  if (!payload) {
    return errorResponse("Invalid or missing payload", 400);
  }

  const { scheduleId, cronExpression, timezone } = payload;

  // Ignore progress notifications — only act on terminal states
  if (status === "progress") {
    return NextResponse.json({ success: true, skipped: true });
  }

  log.debug("Processing cron schedule callback", {
    runId: result.data.runId,
    status,
    scheduleId,
  });

  // Load schedule
  const [schedule] = await globalThis.services.db
    .select()
    .from(zeroAgentSchedules)
    .where(eq(zeroAgentSchedules.id, scheduleId))
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
    : calculateNextRun(cronExpression, timezone);

  await globalThis.services.db
    .update(zeroAgentSchedules)
    .set({
      consecutiveFailures: newFailureCount,
      ...(shouldDisable && { enabled: false }),
      nextRunAt,
      updatedAt: now,
    })
    .where(eq(zeroAgentSchedules.id, scheduleId));

  if (shouldDisable) {
    log.warn("Cron schedule auto-disabled after consecutive failures", {
      scheduleId,
      scheduleName: schedule.name,
      consecutiveFailures: newFailureCount,
    });
  } else {
    log.info(`Cron schedule advanced after ${status}`, {
      scheduleId,
      scheduleName: schedule.name,
      consecutiveFailures: newFailureCount,
      nextRunAt: nextRunAt?.toISOString(),
    });
  }

  return NextResponse.json({ success: true });
}
