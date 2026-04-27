import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../../src/lib/infra/callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { emailThreadSessions } from "@vm0/db/schema/email-thread-session";
import { getUserEmail } from "../../../../../../src/lib/auth/get-user-email";
import { getRunOutputText } from "../../../../../../src/lib/infra/run/extract-run-output";
import { enqueueEmail } from "../../../../../../src/lib/zero/email/outbox-service";
import {
  buildReplyToAddress,
  buildFromAddress,
  buildLogsUrl,
  buildUnsubscribeUrl,
  buildUnsubscribeHeaders,
} from "../../../../../../src/lib/zero/email/handlers/shared";
import { getOrgNameAndSlug } from "../../../../../../src/lib/auth/org-cache";
import type { EmailReplyCallbackPayload } from "../../../../../../src/lib/infra/callback/callback-payloads";
import { saveRunSummary } from "../../../../../../src/lib/zero/run-summary";
import { logger } from "../../../../../../src/lib/shared/logger";

const log = logger("callback:email:reply");

function parsePayload(payload: unknown): EmailReplyCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.emailThreadSessionId !== "string" ||
    typeof p.inboundEmailId !== "string"
  ) {
    return null;
  }
  return p as unknown as EmailReplyCallbackPayload;
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
  payload: EmailReplyCallbackPayload,
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

  const result = await verifyCallback<EmailReplyCallbackPayload>(request, log);
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

  // Get agent name and org
  const [agent] = await globalThis.services.db
    .select({ name: zeroAgents.name, orgId: zeroAgents.orgId })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, session.agentId))
    .limit(1);

  if (!agent) {
    return errorResponse("Agent not found", 404);
  }

  // Resolve org slug for from address
  const orgId = session.orgId ?? agent.orgId;
  const org = await getOrgNameAndSlug(orgId);

  // Get user email
  const userEmail = await getUserEmail(session.userId);
  if (!userEmail) {
    return NextResponse.json({ success: true, skipped: true });
  }

  // Get run output
  const logsUrl = buildLogsUrl(runId);
  const rawOutput =
    status === "completed" ? ((await getRunOutputText(runId)) ?? null) : null;
  const output = formatOutput(status, rawOutput, error);

  // Get agentSessionId from run result for session continuity
  const [run] = await globalThis.services.db
    .select({ result: agentRuns.result, prompt: agentRuns.prompt })
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
    from: buildFromAddress(org.slug),
    to: emailTo,
    subject: `Re: VM0 - Scheduled run for "${agent.name}" completed`,
    template: {
      template: "agent-reply",
      props: { agentName: agent.name, output, logsUrl, unsubscribeUrl },
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

  // Generate run summary (best-effort — errors handled internally)
  if (run?.prompt) {
    await saveRunSummary(runId, "email", run.prompt, rawOutput ?? "");
  }

  log.info("Sent email reply", {
    runId,
    status,
    agentName: agent.name,
  });

  return NextResponse.json({ success: true });
}
