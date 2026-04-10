import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../../src/lib/infra/callback";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { zeroAgents } from "../../../../../../src/db/schema/zero-agent";
import { getRunOutputText } from "../../../../../../src/lib/infra/run/extract-run-output";
import { enqueueEmail } from "../../../../../../src/lib/zero/email/outbox-service";
import {
  buildReplyToAddress,
  buildFromAddress,
  buildLogsUrl,
  buildUnsubscribeUrl,
  buildUnsubscribeHeaders,
} from "../../../../../../src/lib/zero/email/handlers/shared";
import { env } from "../../../../../../src/env";
import { getOrgNameAndSlug } from "../../../../../../src/lib/auth/org-cache";
import type { EmailTriggerCallbackPayload } from "../../../../../../src/lib/infra/callback/callback-payloads";
import { saveRunSummary } from "../../../../../../src/lib/zero/run-summary";
import { logger } from "../../../../../../src/lib/shared/logger";

const log = logger("callback:email:trigger");

function parsePayload(payload: unknown): EmailTriggerCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.senderEmail !== "string" ||
    typeof p.agentId !== "string" ||
    typeof p.userId !== "string" ||
    typeof p.inboundEmailId !== "string" ||
    typeof p.replyToken !== "string"
  ) {
    return null;
  }
  return p as unknown as EmailTriggerCallbackPayload;
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
  inboundReferences: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (inboundMessageId) {
    headers["In-Reply-To"] = inboundMessageId;
    const referencesParts: string[] = [];
    if (inboundReferences) {
      referencesParts.push(inboundReferences);
    }
    referencesParts.push(inboundMessageId);
    headers["References"] = referencesParts.join(" ");
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
 * POST /api/zero/email/callbacks/trigger
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

  const result = await verifyCallback<EmailTriggerCallbackPayload>(
    request,
    log,
  );
  if (!result.ok) return result.response;

  const { runId, status, error } = result.data;

  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return errorResponse("Invalid or missing payload", 400);
  }

  const { senderEmail, agentId, userId, replyToken } = payload;

  log.debug("Processing email trigger callback", { runId, status });

  // Progress notifications are not applicable for email — no-op.
  if (status === "progress") {
    return NextResponse.json({ success: true });
  }

  // Get agent name and org
  const [agent] = await globalThis.services.db
    .select({ name: zeroAgents.name, orgId: zeroAgents.orgId })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, agentId))
    .limit(1);

  if (!agent) {
    return errorResponse("Agent not found", 404);
  }

  // Resolve org slug for from address
  const orgId = payload.runtimeOrgId ?? agent.orgId;
  const org = await getOrgNameAndSlug(orgId);

  // Get run output and session ID
  const logsUrl = buildLogsUrl(runId);
  const rawOutput =
    status === "completed" ? await getRunOutputText(runId) : null;
  const output = formatOutput(status, rawOutput, error);

  const [run] = await globalThis.services.db
    .select({ result: agentRuns.result, prompt: agentRuns.prompt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  const agentSessionId = extractAgentSessionId(run?.result);

  // Only enable reply continuity when we have a session to resume
  const replyToAddress = agentSessionId
    ? buildReplyToAddress(replyToken)
    : undefined;

  const unsubscribeUrl = buildUnsubscribeUrl(userId);
  const headers = {
    ...buildThreadingHeaders(
      payload.inboundMessageId,
      payload.inboundReferences,
    ),
    ...buildUnsubscribeHeaders(unsubscribeUrl),
  };

  // Send response email (use computed recipients if available, fall back to sender)
  const emailTo =
    payload.replyRecipientTo && payload.replyRecipientTo.length > 0
      ? payload.replyRecipientTo
      : senderEmail;
  const emailCc =
    payload.replyRecipientCc && payload.replyRecipientCc.length > 0
      ? payload.replyRecipientCc
      : undefined;

  await enqueueEmail({
    from: buildFromAddress(org.slug),
    to: emailTo,
    subject: buildSubject(payload.subject, agent.name),
    template: {
      template: "agent-reply",
      props: { agentName: agent.name, output, logsUrl, unsubscribeUrl },
    },
    cc: emailCc,
    replyTo: replyToAddress,
    headers,
    threadAction: agentSessionId
      ? {
          action: "save_thread_session",
          userId,
          agentId,
          agentSessionId,
          replyToToken: replyToken,
          orgId: payload.runtimeOrgId,
        }
      : undefined,
  });

  // Generate run summary (best-effort — errors handled internally)
  if (run?.prompt) {
    await saveRunSummary(runId, "email", run.prompt, rawOutput ?? "");
  }

  log.info("Sent email trigger response", {
    runId,
    status,
    agentName: agent.name,
  });

  return NextResponse.json({ success: true });
}
