import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallbackRequest } from "../../../../../../src/lib/callback";
import { decryptCredentialValue } from "../../../../../../src/lib/crypto/secrets-encryption";
import { agentRunCallbacks } from "../../../../../../src/db/schema/agent-run-callback";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { getUserEmail } from "../../../../../../src/lib/auth/get-user-email";
import { getRunOutput } from "../../../../../../src/lib/slack/handlers/run-agent";
import { sendEmail } from "../../../../../../src/lib/email/client";
import {
  generateReplyToken,
  buildReplyToAddress,
  buildFromAddress,
  buildLogsUrl,
  saveEmailThreadSession,
} from "../../../../../../src/lib/email/handlers/shared";
import { ScheduleCompletedEmail } from "../../../../../../src/lib/email/templates/schedule-completed";
import { ScheduleFailedEmail } from "../../../../../../src/lib/email/templates/schedule-failed";
import { env } from "../../../../../../src/env";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("callback:email:schedule");

interface CallbackPayload {
  scheduleId: string;
  composeId: string;
  composeName: string;
  userId: string;
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
    typeof p.composeId !== "string" ||
    typeof p.composeName !== "string" ||
    typeof p.userId !== "string"
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

  // Skip if Resend is not configured
  if (!env().RESEND_API_KEY) {
    return NextResponse.json({ success: true, skipped: true });
  }

  const { SECRETS_ENCRYPTION_KEY } = env();

  // Read raw body for signature verification
  const rawBody = await request.text();

  let body: CallbackBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const { runId, status, error } = body;

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

  const { composeId, composeName, userId } = payload;

  log.debug("Processing email schedule callback", { runId, status });

  // Get user email
  const userEmail = await getUserEmail(userId);
  if (!userEmail) {
    log.debug("No email found for user, skipping notification", { userId });
    return NextResponse.json({ success: true, skipped: true });
  }

  const logsUrl = buildLogsUrl(runId);

  if (status === "completed") {
    // Get agent output
    const output = await getRunOutput(runId);
    const truncatedOutput = output
      ? output.length > 2000
        ? `${output.slice(0, 2000)}…`
        : output
      : "Task completed successfully.";

    // Extract agentSessionId from run result
    const [run] = await globalThis.services.db
      .select({ result: agentRuns.result })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    const result = run?.result;
    const agentSessionId =
      result &&
      typeof result === "object" &&
      "agentSessionId" in result &&
      typeof result.agentSessionId === "string"
        ? result.agentSessionId
        : undefined;

    // Generate reply token and send email
    const sessionPlaceholderId = crypto.randomUUID();
    const replyToken = generateReplyToken(sessionPlaceholderId);
    const replyToAddress = buildReplyToAddress(replyToken);

    const { messageId } = await sendEmail({
      from: buildFromAddress(composeName),
      to: userEmail,
      subject: `VM0 - Scheduled run for "${composeName}" completed`,
      react: ScheduleCompletedEmail({
        agentName: composeName,
        output: truncatedOutput,
        logsUrl,
      }),
      replyTo: replyToAddress,
    });

    // Save email thread session for reply-to-continue
    if (agentSessionId) {
      await saveEmailThreadSession({
        userId,
        composeId,
        agentSessionId,
        lastEmailMessageId: messageId,
        replyToToken: replyToken,
      });
    }
  } else {
    // Failed run
    await sendEmail({
      from: buildFromAddress(composeName),
      to: userEmail,
      subject: `VM0 - Scheduled run for "${composeName}" failed`,
      react: ScheduleFailedEmail({
        agentName: composeName,
        errorMessage: error ?? "Unknown error",
        logsUrl,
      }),
    });
  }

  log.info("Sent email schedule notification", {
    runId,
    status,
    agentName: composeName,
  });

  return NextResponse.json({ success: true });
}
