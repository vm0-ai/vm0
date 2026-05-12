import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../src/lib/infra/callback";
import { extractRunOutput } from "../../../../../src/lib/infra/run/extract-run-output";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { sendAgentPhoneMessage } from "../../../../../src/lib/zero/agentphone/client";
import {
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

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

async function findNewSessionId(
  userId: string,
  agentId: string,
  runCreatedAt: Date,
): Promise<string | undefined> {
  const [newSession] = await globalThis.services.db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.userId, userId),
        eq(agentSessions.agentComposeId, agentId),
        gte(agentSessions.updatedAt, runCreatedAt),
      ),
    )
    .orderBy(desc(agentSessions.updatedAt))
    .limit(1);
  return newSession?.id;
}

function buildAgentPhoneCompletionText(params: {
  status: "completed" | "failed";
  result: string | null;
  error: string | null;
  logsUrl: string | undefined;
}): string {
  const main =
    params.status === "completed"
      ? (params.result ?? "Task completed successfully.")
      : (params.error ?? "The agent encountered an error during execution.");

  return [main, params.logsUrl ? `View run: ${params.logsUrl}` : null]
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
    return NextResponse.json({ success: true });
  }

  const [run] = await globalThis.services.db
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      createdAt: agentRuns.createdAt,
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
  const body = buildAgentPhoneCompletionText({
    status,
    result: runOutput.result,
    error: runOutput.error,
    logsUrl,
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
    const newSessionId = !payload.existingSessionId
      ? await findNewSessionId(run.userId, payload.agentId, run.createdAt)
      : undefined;

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
