import { NextRequest, NextResponse, after } from "next/server";
import { eq, and, gte, desc } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../src/lib/infra/callback";
import { agentSessions } from "../../../../../src/db/schema/agent-session";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { saveIMessageThreadSession } from "../../../../../src/lib/zero/phone/handlers/imessage-shared";
import { sendIMessage } from "../../../../../src/lib/zero/phone/imessage-service";
import { getRunOutputText } from "../../../../../src/lib/infra/run/extract-run-output";
import type { IMessageCallbackPayload } from "../../../../../src/lib/infra/callback/callback-payloads";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("callback:imessage");

function parsePayload(payload: unknown): IMessageCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.messageId !== "string" ||
    typeof p.fromNumber !== "string" ||
    typeof p.userId !== "string" ||
    typeof p.orgId !== "string" ||
    typeof p.agentId !== "string" ||
    typeof p.agentphoneAgentId !== "string"
  ) {
    return null;
  }
  return {
    messageId: p.messageId,
    fromNumber: p.fromNumber,
    userId: p.userId,
    orgId: p.orgId,
    agentId: p.agentId,
    agentphoneAgentId: p.agentphoneAgentId,
    existingSessionId:
      typeof p.existingSessionId === "string" ? p.existingSessionId : null,
  };
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyCallback<IMessageCallbackPayload>(request, log);
  if (!result.ok) return result.response;

  const { runId, status, error } = result.data;

  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  log.debug("Processing iMessage callback", {
    runId,
    status,
    messageId: payload.messageId,
  });

  // Progress callbacks: ignore (no streaming for iMessage)
  if (status === "progress") {
    return NextResponse.json({ success: true });
  }

  if (status === "failed") {
    log.error("iMessage agent run failed", {
      runId,
      messageId: payload.messageId,
      error,
    });
  }

  // Send agent response back via iMessage (fire-and-forget after response).
  // The .catch() is intentional: a delivery failure must not cause a 500 that
  // triggers AgentPhone retries and duplicate messages.
  if (status === "completed") {
    const outputText = await getRunOutputText(runId);

    if (outputText) {
      after(
        sendIMessage({
          agentId: payload.agentphoneAgentId,
          toNumber: payload.fromNumber,
          body: outputText,
        }).catch((err: unknown) => {
          log.warn("Failed to send iMessage reply", { err, runId });
        }),
      );
    }
  }

  // Update thread session
  const [run] = await globalThis.services.db
    .select({ createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (run) {
    const newSessionId = !payload.existingSessionId
      ? await findNewSessionId(payload.userId, payload.agentId, run.createdAt)
      : undefined;

    await saveIMessageThreadSession({
      userId: payload.userId,
      orgId: payload.orgId,
      existingSessionId: payload.existingSessionId ?? undefined,
      newSessionId,
      messageId: payload.messageId,
      runStatus: status,
    });
  }

  log.debug("iMessage callback processed", { runId });
  return NextResponse.json({ success: true });
}
