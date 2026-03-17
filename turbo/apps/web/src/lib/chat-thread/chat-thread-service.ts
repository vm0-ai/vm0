import { eq, and, desc } from "drizzle-orm";
import { chatThreads, chatThreadRuns } from "../../db/schema/chat-thread";
import { agentRuns } from "../../db/schema/agent-run";
import { agentSessions } from "../../db/schema/agent-session";
import { notFound } from "../errors";

/**
 * Create a new chat thread.
 */
export async function createChatThread(
  userId: string,
  agentComposeId: string,
  title?: string | null,
): Promise<{ id: string; createdAt: Date }> {
  const [thread] = await globalThis.services.db
    .insert(chatThreads)
    .values({
      userId,
      agentComposeId,
      title: title ?? null,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });

  if (!thread) {
    throw new Error("Failed to create chat thread");
  }

  return thread;
}

/**
 * List chat threads for a user + agent compose, ordered by updatedAt desc.
 * Derives preview from the first run's prompt.
 */
export async function listChatThreads(
  userId: string,
  agentComposeId: string,
): Promise<
  Array<{
    id: string;
    title: string | null;
    preview: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>
> {
  const threads = await globalThis.services.db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      createdAt: chatThreads.createdAt,
      updatedAt: chatThreads.updatedAt,
    })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.userId, userId),
        eq(chatThreads.agentComposeId, agentComposeId),
      ),
    )
    .orderBy(desc(chatThreads.updatedAt));

  return threads.map((thread) => ({
    ...thread,
    preview: thread.title,
  }));
}

/**
 * Get a chat thread by ID with ownership check.
 */
export async function getChatThread(
  threadId: string,
  userId: string,
): Promise<{
  id: string;
  title: string | null;
  agentComposeId: string;
  createdAt: Date;
  updatedAt: Date;
}> {
  const [thread] = await globalThis.services.db
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .limit(1);

  if (!thread) {
    throw notFound("Chat thread not found");
  }

  return {
    id: thread.id,
    title: thread.title,
    agentComposeId: thread.agentComposeId,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

/**
 * Associate a run to a chat thread. Updates thread's updatedAt.
 */
export async function addRunToThread(
  threadId: string,
  runId: string,
  userId: string,
): Promise<void> {
  // Verify ownership
  const [thread] = await globalThis.services.db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .limit(1);

  if (!thread) {
    throw notFound("Chat thread not found");
  }

  // Insert run association (ignore conflict for idempotency)
  await globalThis.services.db
    .insert(chatThreadRuns)
    .values({ chatThreadId: threadId, runId })
    .onConflictDoNothing();

  // Update thread's updatedAt
  await globalThis.services.db
    .update(chatThreads)
    .set({ updatedAt: new Date() })
    .where(eq(chatThreads.id, threadId));
}

function hasAgentSessionId(
  value: unknown,
): value is { agentSessionId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "agentSessionId" in value &&
    typeof (value as { agentSessionId: unknown }).agentSessionId === "string"
  );
}

/**
 * Get chat messages for a thread by finding the associated session.
 * Resolves: thread → runs → latest completed run → agentSessionId → chatMessages
 */
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "timeout",
  "cancelled",
]);

export async function getChatThreadMessages(
  threadId: string,
  userId: string,
): Promise<{
  chatMessages: Array<{
    role: "user" | "assistant";
    content: string;
    runId?: string;
    createdAt: string;
  }>;
  latestSessionId: string | null;
  activeRunId: string | null;
  activeRunPrompt: string | null;
}> {
  // Get all runs for this thread, ordered by creation time desc
  const runs = await globalThis.services.db
    .select({
      runId: agentRuns.id,
      status: agentRuns.status,
      prompt: agentRuns.prompt,
      result: agentRuns.result,
      continuedFromSessionId: agentRuns.continuedFromSessionId,
    })
    .from(chatThreadRuns)
    .innerJoin(agentRuns, eq(chatThreadRuns.runId, agentRuns.id))
    .where(eq(chatThreadRuns.chatThreadId, threadId))
    .orderBy(desc(chatThreadRuns.createdAt));

  // Find the active (non-terminal) run and the latest sessionId
  let sessionId: string | null = null;
  let activeRunId: string | null = null;
  let activeRunPrompt: string | null = null;

  for (const run of runs) {
    if (!TERMINAL_STATUSES.has(run.status) && !activeRunId) {
      activeRunId = run.runId;
      activeRunPrompt = run.prompt;
    }
    if (!sessionId && hasAgentSessionId(run.result)) {
      sessionId = run.result.agentSessionId;
    }
    if (!sessionId && run.continuedFromSessionId) {
      sessionId = run.continuedFromSessionId;
    }
  }

  if (!sessionId) {
    return {
      chatMessages: [],
      latestSessionId: null,
      activeRunId,
      activeRunPrompt,
    };
  }

  // Load messages from the session
  const [session] = await globalThis.services.db
    .select({ chatMessages: agentSessions.chatMessages })
    .from(agentSessions)
    .where(
      and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)),
    )
    .limit(1);

  type StoredMessage = {
    role: "user" | "assistant";
    content: string;
    runId?: string;
    createdAt: string;
  };

  const messages = (session?.chatMessages ?? []) as StoredMessage[];

  return {
    chatMessages: messages,
    latestSessionId: sessionId,
    activeRunId,
    activeRunPrompt,
  };
}
