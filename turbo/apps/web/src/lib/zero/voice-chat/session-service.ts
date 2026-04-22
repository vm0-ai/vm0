import { eq, and, inArray } from "drizzle-orm";
import {
  voiceChatSessions,
  voiceChatEvents,
} from "../../../db/schema/voice-chat";
import { createZeroRun, type CreateZeroRunResult } from "../zero-run-service";
import { buildVoiceChatQuickPrepPrompt } from "../integration-prompt";
import { notFound, badRequest, forbidden } from "../../shared/errors";
import { adaptVoiceChatSessionTrigger } from "./adapt-voice-chat-session-trigger";
import { cancelSessionPendingRuns } from "./task-service";

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

export async function createSession(
  orgId: string,
  userId: string,
  agentId: string,
) {
  const db = globalThis.services.db;

  const { session, staleIds } = await db.transaction(async (tx) => {
    // Graceful auto-end: emit session-end and flip status, letting the stale
    // slow-brain run self-exit on its next 5s poll. Do NOT cancelRun — that
    // would abort the run mid-step and lose the session-end event trail.
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

    const [inserted] = await tx
      .insert(voiceChatSessions)
      .values({
        orgId,
        userId,
        agentId,
        status: "preparing",
      })
      .returning();

    return {
      session: inserted!,
      staleIds: stale.map((s) => {
        return s.id;
      }),
    };
  });

  // Cancel any in-flight tasker runs on the sessions we just force-ended.
  // Outside the transaction because cancelRun issues sandbox HTTP calls.
  for (const staleId of staleIds) {
    await cancelSessionPendingRuns(staleId);
  }

  return session;
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
  // event within its 5s poll window and self-exits gracefully. Hard-cancelling
  // here would abort the run mid-step and drop the event trail.
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

  // Ephemeral tasker runs don't poll the event log, so they cannot self-exit
  // on session-end the way slow-brain does. Cancel them explicitly.
  await cancelSessionPendingRuns(sessionId);
}

// ---------------------------------------------------------------------------
// Slow-Brain Dispatch
// ---------------------------------------------------------------------------

export async function dispatchSlowBrain(
  session: { id: string },
  userId: string,
  agentId: string,
  options: { apiStartTime: number },
): Promise<CreateZeroRunResult> {
  const db = globalThis.services.db;
  const appendSystemPrompt = buildVoiceChatQuickPrepPrompt(session.id);
  const prompt = `You are Zero's slow-brain for voice-chat session ${session.id}. Review the agent configuration and user context, then prepare an initial directive before the conversation begins.`;

  const result = await createZeroRun(
    adaptVoiceChatSessionTrigger({
      userId,
      agentId,
      prompt,
      appendSystemPrompt,
      sessionId: session.id,
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
