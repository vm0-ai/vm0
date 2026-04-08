import { eq, and } from "drizzle-orm";
import {
  voiceChatSessions,
  voiceChatEvents,
} from "../../../db/schema/voice-chat";
import { createZeroRun } from "../zero-run-service";
import { cancelRun } from "../zero-run-cancel";
import { buildIntegrationContext } from "../integration-context";
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
) {
  const db = globalThis.services.db;

  const [existing] = await db
    .select({ id: voiceChatSessions.id })
    .from(voiceChatSessions)
    .where(
      and(
        eq(voiceChatSessions.userId, userId),
        eq(voiceChatSessions.orgId, orgId),
        eq(voiceChatSessions.status, "active"),
      ),
    )
    .limit(1);

  if (existing) {
    throw conflict("User already has an active voice-chat session");
  }

  const [session] = await db
    .insert(voiceChatSessions)
    .values({ orgId, userId, agentId, status: "active" })
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
        eq(voiceChatSessions.status, "active"),
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
  if (session.status !== "active") {
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

  // Cancel worker run if active (ignore errors if already terminated)
  if (session.runId) {
    try {
      await cancelRun(session.runId, userId, orgId);
    } catch {
      log.debug(`Run ${session.runId} already terminated, skipping cancel`);
    }
  }
}

// ---------------------------------------------------------------------------
// Worker Dispatch
// ---------------------------------------------------------------------------

const VOICE_CHAT_WORKER_PROMPT = `
# Voice-Chat Worker Instructions

You are a background worker supporting a real-time voice conversation between a user and a front-stage Talker AI.

Your job:
1. Periodically check for new events using: \`zero voice-chat context get <SESSION_ID> --after <LAST_SEQ>\`
2. When you find a \`worker-request\` event, process it:
   - Append a \`progress\` event to acknowledge: \`zero voice-chat context append <SESSION_ID> --source worker --type progress --content "Working on it..."\`
   - Complete the task using your available tools
   - Append a \`result\` event with a concise summary: \`zero voice-chat context append <SESSION_ID> --source worker --type result --content "<summary>"\`
3. Keep your output concise — the Talker will read it aloud to the user.
4. Check for new events every 5 seconds.
5. Exit when you see a \`session-end\` system event.
`.trim();

export async function dispatchWorker(
  session: { id: string },
  orgId: string,
  userId: string,
  agentId: string,
) {
  const integrationContext = buildIntegrationContext("Voice-Chat");
  const workerPrompt = VOICE_CHAT_WORKER_PROMPT.replaceAll(
    "<SESSION_ID>",
    session.id,
  );
  const appendSystemPrompt = [integrationContext, workerPrompt].join("\n\n");

  const result = await createZeroRun({
    userId,
    agentId,
    prompt: `You are now the background worker for voice-chat session ${session.id}. Start by checking for new events.`,
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
