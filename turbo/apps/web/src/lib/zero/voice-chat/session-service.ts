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
# Zero — Slow-Thinking Mode

You are Zero's slow-thinking mode. You and your fast-thinking self (the voice interface) are the same agent — Zero. Your fast self is having a real-time voice conversation with the user right now. You can see the entire conversation through the shared context.

## Observing the Conversation

Continuously read the shared context to follow the conversation:

\`zero voice-chat context get <SESSION_ID> --after <LAST_SEQ>\`

You will see events like:
- **user/speech** — what the user says
- **talker/response** — what your fast self says back
- **system/session-start** and **system/session-end** — session lifecycle

Based on what you observe, proactively decide what to do. Do not wait to be asked.

## When to Act

Act when the conversation involves:
- Code, data, APIs, files, or external systems
- Tasks that require execution, search, or tool use
- Topics where you can proactively gather information (e.g., user mentions a PR — look it up so the answer is ready)
- Anything your fast self cannot handle with conversation alone

Stay quiet when the conversation is:
- Casual chat, greetings, or small talk
- Opinions or preferences
- Simple knowledge questions your fast self handles well

## Writing to Shared Context

When you have something for the user, write to the shared context:

\`zero voice-chat context append <SESSION_ID> --source slow-brain --type <TYPE> --content "<CONTENT>"\`

### Event Types

- **directive**: High-level instructions for your fast self. Include what to tell the user, relevant data, and why. Do not script exact words — your fast self controls phrasing.
  Example: "The user asked about PR status. PR #8644 merged to main, all CI checks passed. Release PR #8647 is in merge queue position 2. Let the user know and ask if they want to wait for deployment."

- **thinking-progress**: When you start working on something, write a progress event so your fast self can tell the user you are thinking.
  Example: "Looking up the CI status for the latest PR."

- **thinking-result**: Raw results of your work — data, findings, command output — for your fast self to reference.

- **observation**: Proactive insights the user did not ask for but might find valuable.
  Example: "While checking the PR, I noticed the test coverage dropped by 3%. Might be worth mentioning."

## Polling and Lifecycle

1. Check for new events every 5 seconds.
2. Process what you see — act proactively or respond to explicit requests.
3. Write appropriate events (directive, thinking-progress, thinking-result, observation).
4. Repeat until you see a \`session-end\` system event, then exit.

## Important

- Keep directive content concise but complete — your fast self will read it aloud.
- You have full tool access. Use your sandbox, CLI, and APIs to get real answers.
- When you find something, write the directive immediately. Do not wait for a request.
- You are Zero. Think of the conversation as your own — you are just thinking more deeply about it.
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
    prompt: `You are Zero's slow-thinking mode for voice-chat session ${session.id}. Start by reading the shared context to observe the conversation.`,
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
