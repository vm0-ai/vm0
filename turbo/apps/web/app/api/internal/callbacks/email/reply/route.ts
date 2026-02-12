import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallbackRequest } from "../../../../../../src/lib/callback";
import { decryptCredentialValue } from "../../../../../../src/lib/crypto/secrets-encryption";
import { agentRunCallbacks } from "../../../../../../src/db/schema/agent-run-callback";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { agentComposes } from "../../../../../../src/db/schema/agent-compose";
import { emailThreadSessions } from "../../../../../../src/db/schema/email-thread-session";
import { getUserEmail } from "../../../../../../src/lib/auth/get-user-email";
import { getRunOutput } from "../../../../../../src/lib/slack/handlers/run-agent";
import { sendEmail } from "../../../../../../src/lib/email/client";
import {
  updateEmailThreadSession,
  buildReplyToAddress,
  buildFromAddress,
  buildLogsUrl,
} from "../../../../../../src/lib/email/handlers/shared";
import { AgentReplyEmail } from "../../../../../../src/lib/email/templates/agent-reply";
import { env } from "../../../../../../src/env";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("callback:email:reply");

interface CallbackPayload {
  emailThreadSessionId: string;
  inboundEmailId: string;
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
    typeof p.emailThreadSessionId !== "string" ||
    typeof p.inboundEmailId !== "string"
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
  status: "completed" | "failed",
  rawOutput: string | null,
  error?: string,
): string {
  if (status === "completed") {
    if (!rawOutput) return "Task completed successfully.";
    return rawOutput.length > 2000 ? `${rawOutput.slice(0, 2000)}…` : rawOutput;
  }
  return error ?? "The agent run failed.";
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

  const { emailThreadSessionId } = payload;

  log.debug("Processing email reply callback", { runId, status });

  // Look up the email thread session
  const [session] = await globalThis.services.db
    .select()
    .from(emailThreadSessions)
    .where(eq(emailThreadSessions.id, emailThreadSessionId))
    .limit(1);

  if (!session) {
    log.error("Email thread session not found", {
      sessionId: emailThreadSessionId,
    });
    return errorResponse("Email thread session not found", 404);
  }

  // Get compose name
  const [compose] = await globalThis.services.db
    .select({ name: agentComposes.name })
    .from(agentComposes)
    .where(eq(agentComposes.id, session.composeId))
    .limit(1);

  if (!compose) {
    return errorResponse("Compose not found", 404);
  }

  // Get user email
  const userEmail = await getUserEmail(session.userId);
  if (!userEmail) {
    return NextResponse.json({ success: true, skipped: true });
  }

  // Get run output
  const logsUrl = buildLogsUrl(runId);
  const rawOutput =
    status === "completed" ? ((await getRunOutput(runId)) ?? null) : null;
  const output = formatOutput(status, rawOutput, error);

  // Get agentSessionId from run result for session continuity
  const [run] = await globalThis.services.db
    .select({ result: agentRuns.result })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  const newAgentSessionId = extractAgentSessionId(run?.result);

  // Send response email with threading headers
  const replyToAddress = buildReplyToAddress(session.replyToToken);
  const headers: Record<string, string> = {};

  if (session.lastEmailMessageId) {
    headers["In-Reply-To"] = session.lastEmailMessageId;
    headers["References"] = session.lastEmailMessageId;
  }

  const { messageId } = await sendEmail({
    from: buildFromAddress(compose.name),
    to: userEmail,
    subject: `Re: Reply from "${compose.name}"`,
    react: AgentReplyEmail({
      agentName: compose.name,
      output,
      logsUrl,
    }),
    replyTo: replyToAddress,
    headers,
  });

  // Update email thread session with new message ID and session
  await updateEmailThreadSession(session.id, {
    ...(newAgentSessionId ? { agentSessionId: newAgentSessionId } : {}),
    lastEmailMessageId: messageId,
  });

  log.info("Sent email reply", {
    runId,
    status,
    agentName: compose.name,
  });

  return NextResponse.json({ success: true });
}
