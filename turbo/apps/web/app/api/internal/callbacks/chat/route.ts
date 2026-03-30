import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../src/lib/callback";
import { chatThreads } from "../../../../../src/db/schema/chat-thread";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { findNewSessionId } from "../../../../../src/lib/session/find-new-session";
import type { ChatCallbackPayload } from "../../../../../src/lib/callback/callback-payloads";
import { logger } from "../../../../../src/lib/logger";

const log = logger("callback:chat");

function parsePayload(payload: unknown): ChatCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.threadId !== "string" || typeof p.agentId !== "string") {
    return null;
  }
  return p as unknown as ChatCallbackPayload;
}

/**
 * POST /api/internal/callbacks/chat
 *
 * Chat callback handler for agent run completion.
 * Persists sessionId on the chat thread when a run completes.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyCallback<ChatCallbackPayload>(request, log);
  if (!result.ok) return result.response;

  const { runId, status } = result.data;
  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return NextResponse.json(
      { error: "Invalid or missing payload" },
      { status: 400 },
    );
  }

  // Progress and failure: no session update needed
  if (status !== "completed") {
    return NextResponse.json({ success: true });
  }

  // On completion: persist sessionId on the chat thread
  const [run] = await globalThis.services.db
    .select({ userId: agentRuns.userId, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (!run) {
    return NextResponse.json({ success: true });
  }

  // Check if thread already has a sessionId
  const [thread] = await globalThis.services.db
    .select({ sessionId: chatThreads.sessionId })
    .from(chatThreads)
    .where(eq(chatThreads.id, payload.threadId))
    .limit(1);

  if (thread && !thread.sessionId) {
    const newSessionId = await findNewSessionId(
      run.userId,
      payload.agentId,
      run.createdAt,
    );
    if (newSessionId) {
      await globalThis.services.db
        .update(chatThreads)
        .set({ sessionId: newSessionId })
        .where(eq(chatThreads.id, payload.threadId));
    }
  }

  return NextResponse.json({ success: true });
}
