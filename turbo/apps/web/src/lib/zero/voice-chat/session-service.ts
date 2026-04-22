import { eq, and, inArray, desc, isNotNull } from "drizzle-orm";
import {
  voiceChatSessions,
  voiceChatEvents,
} from "../../../db/schema/voice-chat";
import { agentRuns } from "../../../db/schema/agent-run";
import { createZeroRun, type CreateZeroRunResult } from "../zero-run-service";
import { buildVoiceChatQuickPrepPrompt } from "../integration-prompt";
import { notFound, badRequest, forbidden } from "../../shared/errors";
import { hasAgentSessionId } from "../run-result";
import { adaptVoiceChatSessionTrigger } from "./adapt-voice-chat-session-trigger";

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

export async function createSession(
  orgId: string,
  userId: string,
  agentId: string,
) {
  const db = globalThis.services.db;

  return await db.transaction(async (tx) => {
    // Graceful auto-end: slow-brain sees session-end within 5s and self-exits,
    // populating result.agentSessionId so the new run can resume via
    // getPriorVoiceChatAgentSessionId. Do NOT cancelRun — that skips the webhook.
    const stale = await tx
      .select({ id: voiceChatSessions.id })
      .from(voiceChatSessions)
      .where(
        and(
          eq(voiceChatSessions.userId, userId),
          eq(voiceChatSessions.orgId, orgId),
          inArray(voiceChatSessions.status, ["active", "preparing"]),
        ),
      );

    for (const row of stale) {
      await tx.insert(voiceChatEvents).values({
        sessionId: row.id,
        source: "system",
        type: "session-end",
      });
      await tx
        .update(voiceChatSessions)
        .set({ status: "ended", endedAt: new Date() })
        .where(eq(voiceChatSessions.id, row.id));
    }

    const [session] = await tx
      .insert(voiceChatSessions)
      .values({
        orgId,
        userId,
        agentId,
        status: "preparing",
      })
      .returning();

    return session!;
  });
}

async function getSession(sessionId: string) {
  const db = globalThis.services.db;
  const [session] = await db
    .select()
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, sessionId))
    .limit(1);
  return session ?? null;
}

/**
 * Find the most recent agentSessionId for a user's prior voice chats.
 *
 * Joins voice_chat_sessions with agent_runs via runId and scans the last 5
 * terminated sessions (status IN ('ended', 'timeout')) for this (orgId,
 * userId) — both graceful-exit paths populate result.agentSessionId via the
 * agent-complete webhook. Returns the first populated agentSessionId found,
 * or null when no suitable prior session exists.
 *
 * The 5-row scan (same as chat-thread's getLatestSessionIdForThread) tolerates
 * the race where a just-ended session's run hasn't yet written its result.
 */
export async function getPriorVoiceChatAgentSessionId(
  orgId: string,
  userId: string,
): Promise<string | null> {
  const db = globalThis.services.db;

  const rows = await db
    .select({ result: agentRuns.result })
    .from(voiceChatSessions)
    .innerJoin(agentRuns, eq(voiceChatSessions.runId, agentRuns.id))
    .where(
      and(
        eq(voiceChatSessions.userId, userId),
        eq(voiceChatSessions.orgId, orgId),
        inArray(voiceChatSessions.status, ["ended", "timeout"]),
        isNotNull(voiceChatSessions.runId),
      ),
    )
    .orderBy(desc(voiceChatSessions.createdAt))
    .limit(5);

  for (const row of rows) {
    if (hasAgentSessionId(row.result)) {
      return row.result.agentSessionId;
    }
  }
  return null;
}

export async function heartbeat(
  sessionId: string,
  orgId: string,
  userId: string,
) {
  const db = globalThis.services.db;
  const [updated] = await db
    .update(voiceChatSessions)
    .set({ lastHeartbeatAt: new Date() })
    .where(
      and(
        eq(voiceChatSessions.id, sessionId),
        eq(voiceChatSessions.orgId, orgId),
        eq(voiceChatSessions.userId, userId),
        inArray(voiceChatSessions.status, ["active", "preparing"]),
      ),
    )
    .returning({ id: voiceChatSessions.id });
  return updated ?? null;
}

export async function endSession(
  sessionId: string,
  orgId: string,
  userId: string,
) {
  const db = globalThis.services.db;

  const session = await getSession(sessionId);
  if (!session) {
    throw notFound("Voice-chat session not found");
  }
  if (session.orgId !== orgId || session.userId !== userId) {
    throw forbidden("Not authorized to end this session");
  }
  if (session.status !== "active" && session.status !== "preparing") {
    throw badRequest("Session is not active");
  }

  // Write session-end event and update status atomically. Slow-brain sees the
  // event within its 5s poll window and self-exits via the agent-complete
  // webhook path — which is what populates `agent_runs.result.agentSessionId`
  // so the next voice chat can resume this CC session. Hard-cancelling here
  // would skip that webhook and lose the session id.
  await db.transaction(async (tx) => {
    await tx.insert(voiceChatEvents).values({
      sessionId,
      source: "system",
      type: "session-end",
    });
    await tx
      .update(voiceChatSessions)
      .set({ status: "ended", endedAt: new Date() })
      .where(eq(voiceChatSessions.id, sessionId));
  });
}

// ---------------------------------------------------------------------------
// Slow-Brain Dispatch
// ---------------------------------------------------------------------------

export async function dispatchSlowBrain(
  session: { id: string },
  orgId: string,
  userId: string,
  agentId: string,
  options: { apiStartTime: number },
): Promise<CreateZeroRunResult> {
  const db = globalThis.services.db;
  const appendSystemPrompt = buildVoiceChatQuickPrepPrompt(session.id);
  const prompt = `You are Zero's slow-brain for voice-chat session ${session.id}. Review the agent configuration and user context, then prepare an initial directive before the conversation begins.`;

  const continueFromAgentSessionId =
    (await getPriorVoiceChatAgentSessionId(orgId, userId)) ?? undefined;

  const result = await createZeroRun(
    adaptVoiceChatSessionTrigger({
      userId,
      agentId,
      prompt,
      appendSystemPrompt,
      sessionId: session.id,
      continueFromAgentSessionId,
      apiStartTime: options.apiStartTime,
    }),
  );

  // Update session with runId
  await db
    .update(voiceChatSessions)
    .set({ runId: result.runId })
    .where(eq(voiceChatSessions.id, session.id));

  // Write session-start event
  await db.insert(voiceChatEvents).values({
    sessionId: session.id,
    source: "system",
    type: "session-start",
  });

  return result;
}

// ---------------------------------------------------------------------------
// Session Activation (preparing → active)
// ---------------------------------------------------------------------------

export async function activateSession(
  sessionId: string,
  orgId: string,
  userId: string,
) {
  const db = globalThis.services.db;

  const session = await getSession(sessionId);
  if (!session) {
    throw notFound("Voice-chat session not found");
  }
  if (session.orgId !== orgId || session.userId !== userId) {
    throw forbidden("Not authorized to activate this session");
  }
  if (session.status !== "preparing") {
    throw badRequest("Session is not in preparing status");
  }

  const [updated] = await db
    .update(voiceChatSessions)
    .set({ status: "active" })
    .where(eq(voiceChatSessions.id, sessionId))
    .returning();

  return updated!;
}
