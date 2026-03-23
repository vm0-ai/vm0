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
 * Represents a run whose messages are not persisted in the session yet.
 * The frontend uses these to reconstruct the full conversation on refresh.
 */
interface UnsavedRun {
  runId: string;
  status: string;
  prompt: string;
  error: string | null;
}

export async function getChatThreadMessages(
  threadId: string,
  userId: string,
): Promise<{
  chatMessages: Array<{
    role: "user" | "assistant";
    content: string;
    runId?: string;
    error?: string;
    summaries?: string[];
    createdAt: string;
  }>;
  latestSessionId: string | null;
  /** Runs not yet reflected in chatMessages (active, failed, etc.) */
  unsavedRuns: UnsavedRun[];
}> {
  // Get all runs for this thread, ordered by creation time ASC (chronological)
  const runs = await globalThis.services.db
    .select({
      runId: agentRuns.id,
      status: agentRuns.status,
      prompt: agentRuns.prompt,
      error: agentRuns.error,
      result: agentRuns.result,
      continuedFromSessionId: agentRuns.continuedFromSessionId,
      createdAt: agentRuns.createdAt,
    })
    .from(chatThreadRuns)
    .innerJoin(agentRuns, eq(chatThreadRuns.runId, agentRuns.id))
    .where(eq(chatThreadRuns.chatThreadId, threadId))
    .orderBy(chatThreadRuns.createdAt);

  let sessionId: string | null = null;
  const savedRunIds = new Set<string>();

  for (const run of runs) {
    if (hasAgentSessionId(run.result)) {
      sessionId = run.result.agentSessionId;
      savedRunIds.add(run.runId);
    }
    if (!sessionId && run.continuedFromSessionId) {
      sessionId = run.continuedFromSessionId;
    }
  }

  // Load messages from the session
  type StoredMessage = {
    role: "user" | "assistant";
    content: string;
    runId?: string;
    summaries?: string[];
    createdAt: string;
  };
  let messages: StoredMessage[] = [];

  if (sessionId) {
    const [session] = await globalThis.services.db
      .select({ chatMessages: agentSessions.chatMessages })
      .from(agentSessions)
      .where(
        and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)),
      )
      .limit(1);
    messages = (session?.chatMessages ?? []) as StoredMessage[];

    // Mark runs that have messages in the session
    for (const msg of messages) {
      if (msg.runId) {
        savedRunIds.add(msg.runId);
      }
    }
  }

  // Build a map of run errors for failed runs that are in chatMessages
  const runErrorMap = new Map<string, string>();
  for (const run of runs) {
    if (run.error && savedRunIds.has(run.runId)) {
      runErrorMap.set(run.runId, run.error);
    }
  }

  // Inject error into chatMessages for failed runs
  const enrichedMessages = messages.map((m) => {
    if (m.runId && runErrorMap.has(m.runId)) {
      return { ...m, error: runErrorMap.get(m.runId)! };
    }
    return m;
  });

  // Collect runs not reflected in chatMessages (active, failed, pending, etc.)
  const unsavedRuns: UnsavedRun[] = runs
    .filter((r) => !savedRunIds.has(r.runId))
    .map((r) => ({
      runId: r.runId,
      status: r.status,
      prompt: r.prompt,
      error: r.error,
    }));

  return {
    chatMessages: enrichedMessages,
    latestSessionId: sessionId,
    unsavedRuns,
  };
}
