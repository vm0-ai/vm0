import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../src/lib/infra/callback";
import { extractRunOutput } from "../../../../../src/lib/infra/run/extract-run-output";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  sendAgentPhoneMessage,
  sendAgentPhoneTypingIndicator,
} from "../../../../../src/lib/zero/agentphone/client";
import {
  formatAgentPhoneAuditLink,
  resolveAgentPhoneReplyFooterText,
} from "../../../../../src/lib/zero/agentphone/footer";
import {
  resolveAgentPhoneUserLink,
  saveAgentPhoneThreadSession,
  storeOutboundAgentPhoneMessage,
} from "../../../../../src/lib/zero/agentphone/shared";
import { resolveTelegramAuditLogsUrl } from "../../../../../src/lib/zero/telegram/handlers/shared";
import type { AgentPhoneCallbackPayload } from "../../../../../src/lib/infra/callback/callback-payloads";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("callback:agentphone");

function parsePayload(payload: unknown): AgentPhoneCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.messageId !== "string" ||
    typeof p.phoneHandle !== "string" ||
    typeof p.fromNumber !== "string" ||
    typeof p.toNumber !== "string" ||
    typeof p.userLinkId !== "string" ||
    typeof p.agentId !== "string" ||
    typeof p.agentphoneAgentId !== "string"
  ) {
    return null;
  }

  return {
    messageId: p.messageId,
    conversationId:
      typeof p.conversationId === "string" ? p.conversationId : null,
    channel: typeof p.channel === "string" ? p.channel : "unknown",
    phoneHandle: p.phoneHandle,
    fromNumber: p.fromNumber,
    toNumber: p.toNumber,
    userLinkId: p.userLinkId,
    agentId: p.agentId,
    agentphoneAgentId: p.agentphoneAgentId,
    existingSessionId:
      typeof p.existingSessionId === "string" ? p.existingSessionId : null,
  };
}

async function refreshAgentPhoneTyping(
  payload: AgentPhoneCallbackPayload,
  runId: string,
): Promise<void> {
  if (payload.channel !== "imessage" || !payload.conversationId) return;

  try {
    await sendAgentPhoneTypingIndicator({
      conversationId: payload.conversationId,
    });
  } catch (err) {
    log.debug("Failed to refresh AgentPhone typing indicator", {
      runId,
      error: err,
    });
  }
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function buildAgentPhoneCompletionText(params: {
  status: "completed" | "failed";
  result: string | null;
  error: string | null;
  logsUrl: string | undefined;
  footerText: string | undefined;
}): string {
  const main =
    params.status === "completed"
      ? (params.result ?? "Task completed successfully.")
      : (params.error ?? "The agent encountered an error during execution.");

  return [
    main,
    params.logsUrl ? formatAgentPhoneAuditLink(params.logsUrl) : null,
    params.footerText,
  ]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join("\n\n");
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyCallback<AgentPhoneCallbackPayload>(request, log);
  if (!result.ok) return result.response;

  const { runId, status, error } = result.data;
  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return errorResponse("Invalid or missing payload", 400);
  }

  if (status === "progress") {
    await refreshAgentPhoneTyping(payload, runId);
    return NextResponse.json({ success: true });
  }

  const currentUserLink = await resolveAgentPhoneUserLink(payload.phoneHandle);
  if (currentUserLink?.id !== payload.userLinkId) {
    log.info("Skipping stale AgentPhone callback for disconnected phone link", {
      runId,
      userLinkId: payload.userLinkId,
    });
    return NextResponse.json({ success: true });
  }

  const [run] = await globalThis.services.db
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      sessionId: agentRuns.sessionId,
      lastEventSequence: agentRuns.lastEventSequence,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (status === "failed") {
    log.error("AgentPhone agent run failed", { runId, error });
  }

  const runOutput = await extractRunOutput(
    runId,
    error,
    run?.lastEventSequence,
  );
  const logsUrl = run
    ? await resolveTelegramAuditLogsUrl({
        orgId: run.orgId,
        userId: run.userId,
        runId,
      })
    : undefined;
  const footerText = run
    ? await resolveAgentPhoneReplyFooterText({
        orgId: run.orgId,
        runId,
        agentId: payload.agentId,
      })
    : undefined;
  const body = buildAgentPhoneCompletionText({
    status,
    result: runOutput.result,
    error: runOutput.error,
    logsUrl,
    footerText,
  });

  const sent = await sendAgentPhoneMessage({
    agentphoneAgentId: payload.agentphoneAgentId,
    toNumber: payload.phoneHandle,
    body,
  });

  await storeOutboundAgentPhoneMessage({
    agentphoneMessageId: sent.id,
    conversationId: payload.conversationId,
    agentphoneAgentId: payload.agentphoneAgentId,
    userLinkId: payload.userLinkId,
    phoneHandle: payload.phoneHandle,
    fromNumber: sent.fromNumber ?? payload.toNumber,
    toNumber: sent.toNumber ?? payload.phoneHandle,
    body,
    channel: sent.channel,
  });

  if (run) {
    const newSessionId = !payload.existingSessionId ? run.sessionId : undefined;

    await saveAgentPhoneThreadSession({
      userLinkId: payload.userLinkId,
      conversationId: payload.conversationId,
      existingSessionId: payload.existingSessionId ?? undefined,
      newSessionId,
      messageId: payload.messageId,
      runStatus: status,
    });
  }

  log.debug("AgentPhone callback processed successfully", { runId });
  return NextResponse.json({ success: true });
}
