import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallbackRequest } from "../../../../../../src/lib/callback";
import { decryptCredentialValue } from "../../../../../../src/lib/crypto/secrets-encryption";
import { agentRunCallbacks } from "../../../../../../src/db/schema/agent-run-callback";
import { agentSchedules } from "../../../../../../src/db/schema/agent-schedule";
import { env } from "../../../../../../src/env";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("callback:schedule:loop");

// Auto-disable after this many consecutive failures
const MAX_CONSECUTIVE_FAILURES = 3;

interface CallbackPayload {
  scheduleId: string;
  intervalSeconds: number;
}

interface CallbackBody {
  runId: string;
  status: "completed" | "failed";
  result?: Record<string, unknown>;
  error?: string;
  payload: CallbackPayload;
}

function parsePayload(body: CallbackBody): CallbackPayload | null {
  if (!body.payload) return null;
  const p = body.payload;
  if (
    typeof p.scheduleId !== "string" ||
    typeof p.intervalSeconds !== "number"
  ) {
    return null;
  }
  return p;
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();
  const { SECRETS_ENCRYPTION_KEY } = env();

  // Read raw body for signature verification
  const rawBody = await request.text();

  let body: CallbackBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const { runId, status } = body;

  if (!runId) {
    return errorResponse("Missing runId", 400);
  }

  // Query callback record to get the per-callback secret
  const [callback] = await globalThis.services.db
    .select({ encryptedSecret: agentRunCallbacks.encryptedSecret })
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, runId))
    .limit(1);

  if (!callback) {
    log.warn("Callback record not found", { runId });
    return errorResponse("Callback not found", 404);
  }

  // Decrypt the per-callback secret and verify signature
  const callbackSecret = decryptCredentialValue(
    callback.encryptedSecret,
    SECRETS_ENCRYPTION_KEY,
  );

  const signature = request.headers.get("X-VM0-Signature");
  const timestamp = request.headers.get("X-VM0-Timestamp");

  const verification = verifyCallbackRequest(
    rawBody,
    callbackSecret,
    signature,
    timestamp,
  );

  if (!verification.valid) {
    log.warn("Callback signature verification failed", {
      runId,
      error: verification.error,
    });
    return errorResponse(verification.error ?? "Invalid signature", 401);
  }

  const payload = parsePayload(body);
  if (!payload) {
    return errorResponse("Invalid or missing payload", 400);
  }

  const { scheduleId, intervalSeconds } = payload;

  log.debug("Processing loop schedule callback", { runId, status, scheduleId });

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
