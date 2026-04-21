import { eq, and, inArray, desc, isNotNull } from "drizzle-orm";
import {
  voiceChatSessions,
  voiceChatEvents,
} from "../../../db/schema/voice-chat";
import { agentRuns } from "../../../db/schema/agent-run";
import { createZeroRun, type CreateZeroRunResult } from "../zero-run-service";
import {
  buildVoiceChatQuickPrepPrompt,
  buildVoiceChatMeetingPrompt,
  buildVoiceChatObservationOnlyPrompt,
} from "../integration-prompt";
import { conflict, notFound, badRequest, forbidden } from "../../shared/errors";
import { hasAgentSessionId } from "../run-result";
import { adaptVoiceChatSessionTrigger } from "./adapt-voice-chat-session-trigger";

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

export async function createSession(
  orgId: string,
  userId: string,
  agentId: string,
  options?: { mode?: "chat" | "meeting"; prompt?: string },
) {
  const db = globalThis.services.db;

  const [existing] = await db
    .select({ id: voiceChatSessions.id })
    .from(voiceChatSessions)
    .where(
      and(
        eq(voiceChatSessions.userId, userId),
        eq(voiceChatSessions.orgId, orgId),
        inArray(voiceChatSessions.status, ["active", "preparing"]),
      ),
    )
    .limit(1);

  if (existing) {
    throw conflict("User already has an active voice-chat session");
  }

  const mode = options?.mode ?? "chat";
  const status = "preparing";

  const [session] = await db
    .insert(voiceChatSessions)
    .values({
      orgId,
      userId,
      agentId,
      mode,
      prompt: options?.prompt ?? null,
      status,
    })
    .returning();

  // Insert always returns the inserted row
  return session!;
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
  options: {
    mode?: "chat" | "meeting";
    prompt?: string;
    apiStartTime: number;
  },
): Promise<CreateZeroRunResult> {
  const db = globalThis.services.db;
  const meetingPrompt = options.mode === "meeting" ? options.prompt : undefined;

  const appendSystemPrompt = meetingPrompt
    ? buildVoiceChatMeetingPrompt(session.id, meetingPrompt)
    : buildVoiceChatQuickPrepPrompt(session.id);

  const prompt = meetingPrompt
    ? `You are Zero's slow-brain for voice-chat session ${session.id}. A meeting has been requested. Read the shared context for the meeting prompt and begin preparation.`
    : `You are Zero's slow-brain for voice-chat session ${session.id}. Review the agent configuration and user context, then prepare an initial directive before the conversation begins.`;

  // Write meeting-prompt event before session-start (meeting mode only)
  if (meetingPrompt) {
    await db.insert(voiceChatEvents).values({
      sessionId: session.id,
      source: "user",
      type: "meeting-prompt",
      content: meetingPrompt,
    });
  }

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
// Cached Preparation Events
// ---------------------------------------------------------------------------

export async function writeCachedPreparationEvents(
  sessionId: string,
  directiveContent: string,
) {
  const db = globalThis.services.db;
  await db.insert(voiceChatEvents).values([
    {
      sessionId,
      source: "slow-brain",
      type: "thinking",
      content: "Reviewing agent context and preparing initial guidance...",
    },
    {
      sessionId,
      source: "slow-brain",
      type: "directive",
      content: directiveContent,
    },
    {
      sessionId,
      source: "slow-brain",
      type: "preparation-ready",
    },
  ]);
}

// ---------------------------------------------------------------------------
// Observation-Only Slow-Brain Dispatch
// ---------------------------------------------------------------------------

export async function dispatchObservationSlowBrain(
  session: {
    id: string;
    orgId: string;
    userId: string;
    agentId: string;
  },
  apiStartTime: number,
): Promise<CreateZeroRunResult> {
  const db = globalThis.services.db;
  const appendSystemPrompt = buildVoiceChatObservationOnlyPrompt(session.id);
  const prompt = `You are Zero's slow-brain for voice-chat session ${session.id}. Preparation is complete. Start observing the conversation.`;

  const continueFromAgentSessionId =
    (await getPriorVoiceChatAgentSessionId(session.orgId, session.userId)) ??
    undefined;

  const result = await createZeroRun(
    adaptVoiceChatSessionTrigger({
      userId: session.userId,
      agentId: session.agentId,
      prompt,
      appendSystemPrompt,
      sessionId: session.id,
      continueFromAgentSessionId,
      apiStartTime,
    }),
  );

  await db
    .update(voiceChatSessions)
    .set({ runId: result.runId })
    .where(eq(voiceChatSessions.id, session.id));

  await db.insert(voiceChatEvents).values({
    sessionId: session.id,
    source: "system",
    type: "session-start",
  });

  return result;
}

// ---------------------------------------------------------------------------
// Session Activation (meeting mode: preparing → active)
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
