import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallbackRequest } from "../../../../../../src/lib/callback";
import { decryptCredentialValue } from "../../../../../../src/lib/crypto/secrets-encryption";
import { agentRunCallbacks } from "../../../../../../src/db/schema/agent-run-callback";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { agentComposes } from "../../../../../../src/db/schema/agent-compose";
import { getRunOutput } from "../../../../../../src/lib/slack/handlers/run-agent";
import { sendEmail } from "../../../../../../src/lib/email/client";
import {
  saveEmailThreadSession,
  buildReplyToAddress,
  buildFromAddress,
  buildLogsUrl,
} from "../../../../../../src/lib/email/handlers/shared";
import { AgentReplyEmail } from "../../../../../../src/lib/email/templates/agent-reply";
import { env } from "../../../../../../src/env";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("callback:email:trigger");

interface CallbackPayload {
  senderEmail: string;
  composeId: string;
  userId: string;
  inboundEmailId: string;
  replyToken: string;
  inboundMessageId?: string;
  subject?: string;
  triggerLocalPart?: string;
}

interface CallbackBody {
  runId: string;
  status: "completed" | "failed";
  result?: Record<string, unknown>;
  error?: string;
  payload: CallbackPayload;
}

function parsePayload(body: CallbackBody): CallbackPayload | null {
  const p = body.payload;
  if (!p) return null;
  if (
    typeof p.senderEmail !== "string" ||
    typeof p.composeId !== "string" ||
    typeof p.userId !== "string" ||
    typeof p.inboundEmailId !== "string" ||
    typeof p.replyToken !== "string"
  ) {
    return null;
  }
  return p;
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function extractAgentSessionId(result: unknown): string | undefined {
  if (
    result &&
    typeof result === "object" &&
    "agentSessionId" in result &&
    typeof result.agentSessionId === "string"
  ) {
    return result.agentSessionId;
  }
  return undefined;
}

function formatOutput(
  status: string,
  rawOutput: string | null | undefined,
  error: string | undefined,
): string {
  if (status !== "completed") {
    return error ?? "The agent run failed.";
  }
  if (!rawOutput) {
    return "Task completed successfully.";
  }
  return rawOutput.length > 2000 ? `${rawOutput.slice(0, 2000)}…` : rawOutput;
}

function buildThreadingHeaders(
  inboundMessageId: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (inboundMessageId) {
    headers["In-Reply-To"] = inboundMessageId;
    headers["References"] = inboundMessageId;
  }
  return headers;
}

function buildSubject(
  inboundSubject: string | undefined,
  composeName: string,
): string {
  const cleanSubject = inboundSubject?.replace(/^Re:\s*/i, "") ?? composeName;
  return `Re: ${cleanSubject}`;
}

/**
 * Email Trigger Callback Handler
 *
 * POST /api/internal/callbacks/email/trigger
 *
 * Called when an agent run (triggered by email) completes.
 * Sends the response email to the original sender and creates
 * an email thread session for conversation continuity.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  // Skip if Resend is not configured
  if (!env().RESEND_API_KEY) {
    return NextResponse.json({ success: true, skipped: true });
  }

  const { SECRETS_ENCRYPTION_KEY } = env();

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

  // Verify callback signature
  const [callback] = await globalThis.services.db
    .select({ encryptedSecret: agentRunCallbacks.encryptedSecret })
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, runId))
    .limit(1);

  if (!callback) {
    log.warn("Callback record not found", { runId });
    return errorResponse("Callback not found", 404);
  }

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

  const { senderEmail, composeId, userId, replyToken } = payload;

  log.debug("Processing email trigger callback", { runId, status });

  // Get compose name
  const [compose] = await globalThis.services.db
    .select({ name: agentComposes.name })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!compose) {
    return errorResponse("Compose not found", 404);
  }

  // Get run output and session ID
  const logsUrl = buildLogsUrl(runId);
  const rawOutput = status === "completed" ? await getRunOutput(runId) : null;
  const output = formatOutput(status, rawOutput, error);

  const [run] = await globalThis.services.db
    .select({ result: agentRuns.result })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  const agentSessionId = extractAgentSessionId(run?.result);

  // Only enable reply continuity when we have a session to resume
  const replyToAddress = agentSessionId
    ? buildReplyToAddress(replyToken)
    : undefined;

  const headers = buildThreadingHeaders(payload.inboundMessageId);

  // Send response email
  const { messageId } = await sendEmail({
    from: buildFromAddress(payload.triggerLocalPart ?? compose.name),
    to: senderEmail,
    subject: buildSubject(payload.subject, compose.name),
    react: AgentReplyEmail({
      agentName: compose.name,
      output,
      logsUrl,
    }),
    replyTo: replyToAddress,
    headers,
  });

  // Save email thread session for reply continuity
  if (agentSessionId) {
    await saveEmailThreadSession({
      userId,
      composeId,
      agentSessionId,
      lastEmailMessageId: messageId,
      replyToToken: replyToken,
    });
  }

  log.info("Sent email trigger response", {
    runId,
    status,
    agentName: compose.name,
  });

  return NextResponse.json({ success: true });
}
