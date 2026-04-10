import { eq, and, inArray } from "drizzle-orm";
import {
  voiceChatSessions,
  voiceChatEvents,
} from "../../../db/schema/voice-chat";
import { createZeroRun } from "../zero-run-service";
import { cancelRun } from "../zero-run-cancel";
import { buildVoiceChatSlowBrainPrompt } from "../integration-prompt";
import { conflict, notFound, badRequest, forbidden } from "../../shared/errors";
import { logger } from "../../shared/logger";

const log = logger("zero:voice-chat:session");

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
  const status = mode === "meeting" ? "preparing" : "active";

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

  // Write session-end event
  await db.insert(voiceChatEvents).values({
    sessionId,
    source: "system",
    type: "session-end",
  });

  // Update session status
  await db
    .update(voiceChatSessions)
    .set({ status: "ended", endedAt: new Date() })
    .where(eq(voiceChatSessions.id, sessionId));

  // Cancel slow-brain run if active (ignore errors if already terminated)
  if (session.runId) {
    try {
      await cancelRun(session.runId, userId, orgId);
    } catch {
      log.debug(`Run ${session.runId} already terminated, skipping cancel`);
    }
  }
}

// ---------------------------------------------------------------------------
// Slow-Brain Dispatch
// ---------------------------------------------------------------------------

export async function dispatchSlowBrain(
  session: { id: string },
  orgId: string,
  userId: string,
  agentId: string,
) {
  const appendSystemPrompt = buildVoiceChatSlowBrainPrompt(session.id);

  const result = await createZeroRun({
    userId,
    agentId,
    prompt: `You are Zero's slow-brain for voice-chat session ${session.id}. Start by reading the shared context to observe the conversation.`,
    appendSystemPrompt,
    triggerSource: "voice-chat",
  });

  // Update session with runId
  const db = globalThis.services.db;
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
