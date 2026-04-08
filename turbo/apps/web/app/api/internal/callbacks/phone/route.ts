import { NextRequest, NextResponse } from "next/server";
import { eq, and, gte, desc } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../src/lib/infra/callback";
import { agentSessions } from "../../../../../src/db/schema/agent-session";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { savePhoneThreadSession } from "../../../../../src/lib/zero/phone/handlers/shared";
import type { PhoneCallbackPayload } from "../../../../../src/lib/infra/callback/callback-payloads";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("callback:phone");

function parsePayload(payload: unknown): PhoneCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.callId !== "string" ||
    typeof p.userId !== "string" ||
    typeof p.orgId !== "string" ||
    typeof p.agentId !== "string"
  ) {
    return null;
  }
  return {
    callId: p.callId,
    userId: p.userId,
    orgId: p.orgId,
    agentId: p.agentId,
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

  const result = await verifyCallback<PhoneCallbackPayload>(request, log);
  if (!result.ok) return result.response;

  const { runId, status, error } = result.data;

  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  log.debug("Processing phone callback", {
    runId,
    status,
    callId: payload.callId,
  });

  // Progress callbacks: no action for phone (user already hung up)
  if (status === "progress") {
    return NextResponse.json({ success: true });
  }

  if (status === "failed") {
    log.error("Phone agent run failed", {
      runId,
      callId: payload.callId,
      error,
    });
  }

  // Get run to find createdAt for session lookup
  const [run] = await globalThis.services.db
    .select({ createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (run) {
    const newSessionId = !payload.existingSessionId
      ? await findNewSessionId(payload.userId, payload.agentId, run.createdAt)
      : undefined;

    await savePhoneThreadSession({
      userId: payload.userId,
      orgId: payload.orgId,
      existingSessionId: payload.existingSessionId ?? undefined,
      newSessionId,
      callId: payload.callId,
      runStatus: status,
    });
  }

  log.debug("Phone callback processed", { runId });
  return NextResponse.json({ success: true });
}
