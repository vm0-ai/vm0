import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../../src/lib/callback";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { agentComposes } from "../../../../../../src/db/schema/agent-compose";
import { emailThreadSessions } from "../../../../../../src/db/schema/email-thread-session";
import { getUserEmail } from "../../../../../../src/lib/auth/get-user-email";
import { getRunOutput } from "../../../../../../src/lib/slack/handlers/run-agent";
import { enqueueEmail } from "../../../../../../src/lib/email/outbox-service";
import {
  buildReplyToAddress,
  buildFromAddress,
  buildLogsUrl,
  buildUnsubscribeUrl,
  buildUnsubscribeHeaders,
} from "../../../../../../src/lib/email/handlers/shared";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("callback:email:reply");

interface CallbackPayload {
  emailThreadSessionId: string;
  inboundEmailId: string;
  inboundMessageId?: string;
  inboundReferences?: string;
  replyRecipientTo?: string[];
  replyRecipientCc?: string[];
}

function parsePayload(payload: unknown): CallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.emailThreadSessionId !== "string" ||
    typeof p.inboundEmailId !== "string"
  ) {
    return null;
  }
  return p as unknown as CallbackPayload;
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

function buildThreadingHeaders(
  payload: CallbackPayload,
  lastEmailMessageId: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {};

  const replyToMessageId = payload.inboundMessageId ?? lastEmailMessageId;
  if (replyToMessageId) {
    headers["In-Reply-To"] = replyToMessageId;
  }

  const referencesParts: string[] = [];
  if (payload.inboundReferences) {
    referencesParts.push(payload.inboundReferences);
  } else if (lastEmailMessageId) {
    referencesParts.push(lastEmailMessageId);
  }
  if (payload.inboundMessageId) {
    referencesParts.push(payload.inboundMessageId);
  }
  if (referencesParts.length > 0) {
    headers["References"] = referencesParts.join(" ");
  }

  return headers;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyCallback<CallbackPayload>(request, log);
  if (!result.ok) return result.response;

  const { runId, status, error } = result.data;

  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return errorResponse("Invalid or missing payload", 400);
  }

  const { emailThreadSessionId } = payload;

  log.debug("Processing email reply callback", { runId, status });

  // Progress notifications are not applicable for email — no-op.
  if (status === "progress") {
    return NextResponse.json({ success: true });
  }

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

  // Build threading headers and recipients
  const unsubscribeUrl = buildUnsubscribeUrl(session.userId);
  const headers = {
    ...buildThreadingHeaders(payload, session.lastEmailMessageId),
    ...buildUnsubscribeHeaders(unsubscribeUrl),
  };

  const emailTo =
    payload.replyRecipientTo && payload.replyRecipientTo.length > 0
      ? payload.replyRecipientTo
      : userEmail;
  const emailCc =
    payload.replyRecipientCc && payload.replyRecipientCc.length > 0
      ? payload.replyRecipientCc
      : undefined;

  // Send response email via outbox queue
  await enqueueEmail({
    from: buildFromAddress(compose.name),
    to: emailTo,
    subject: `Re: VM0 - Scheduled run for "${compose.name}" completed`,
    template: {
      template: "agent-reply",
      props: { agentName: compose.name, output, logsUrl, unsubscribeUrl },
    },
    cc: emailCc,
    replyTo: buildReplyToAddress(session.replyToToken),
    headers,
    threadAction: {
      action: "update_thread_session",
      sessionId: session.id,
      ...(newAgentSessionId ? { agentSessionId: newAgentSessionId } : {}),
    },
  });

  log.info("Sent email reply", {
    runId,
    status,
    agentName: compose.name,
  });

  return NextResponse.json({ success: true });
}
