import { eq, and, desc } from "drizzle-orm";
import { chatThreads, chatThreadRuns } from "../../../db/schema/chat-thread";
import { agentRuns } from "../../../db/schema/agent-run";
import { notFound } from "../../shared/errors";
import {
  getChatMessagesForSession,
  type StoredChatMessage,
} from "../zero-session-service";
import {
  type SummaryEntry,
  type PersistedAttachment,
  persistedAttachmentSchema,
} from "@vm0/core";
import type { TitleContextMessage } from "../ai/lightweight-model";

/**
 * Create a new chat thread.
 *
 * `sourceScheduleRunId`, when set, marks this thread as continuing a
 * previously scheduled agent run. The chat messages route reads it once on the
 * thread's first run to seed a system prompt instructing the agent to pull the
 * original run's telemetry via `zero logs <id>`; subsequent runs inherit the
 * resulting session context and do not get the prompt again.
 */
export async function createChatThread(
  userId: string,
  agentComposeId: string,
  title?: string | null,
  sourceScheduleRunId?: string | null,
): Promise<{ id: string; createdAt: Date }> {
  const [thread] = await globalThis.services.db
    .insert(chatThreads)
    .values({
      userId,
      agentComposeId,
      title: title ?? null,
      sourceScheduleRunId: sourceScheduleRunId ?? null,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });

  if (!thread) {
    throw new Error("Failed to create chat thread");
  }

  return thread;
}

/**
 * List chat threads for a user + agent compose, ordered by updatedAt desc.
 */
export async function listChatThreads(
  userId: string,
  agentComposeId: string,
): Promise<
  Array<{
    id: string;
    title: string | null;
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

  return threads;
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
  sessionId: string | null;
  sourceScheduleRunId: string | null;
  draftContent: string | null;
  draftAttachments: PersistedAttachment[] | null;
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
    sessionId: thread.sessionId ?? null,
    sourceScheduleRunId: thread.sourceScheduleRunId ?? null,
    draftContent: thread.draftContent ?? null,
    draftAttachments: persistedAttachmentSchema
      .array()
      .nullable()
      .parse(thread.draftAttachments ?? null),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

/**
 * Update a chat thread's draft content and attachments.
 * Ownership check in WHERE clause ensures users can only update their own threads.
 */
export async function updateChatThreadDraft(
  threadId: string,
  userId: string,
  draftContent: string | null,
  draftAttachments: PersistedAttachment[] | null,
): Promise<void> {
  const updated = await globalThis.services.db
    .update(chatThreads)
    .set({ draftContent, draftAttachments })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .returning({ id: chatThreads.id });

  if (updated.length === 0) {
    throw notFound("Chat thread not found");
  }
}

/**
 * Returns true when the thread has no associated runs yet, i.e. the next run
 * will be its first. Used to decide whether to seed the source-schedule system
 * prompt (only on the first run; later runs inherit the session context).
 */
export async function threadHasNoRuns(threadId: string): Promise<boolean> {
  const [existing] = await globalThis.services.db
    .select({ id: chatThreadRuns.id })
    .from(chatThreadRuns)
    .where(eq(chatThreadRuns.chatThreadId, threadId))
    .limit(1);
  return !existing;
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

/**
 * Delete a chat thread with ownership check.
 * Cascade deletes handle chat_thread_runs cleanup.
 */
export async function deleteChatThread(
  threadId: string,
  userId: string,
): Promise<void> {
  const deleted = await globalThis.services.db
    .delete(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .returning({ id: chatThreads.id });

  if (deleted.length === 0) {
    throw notFound("Chat thread not found");
  }
}

/**
 * Update a chat thread's title.
 */
export async function updateChatThreadTitle(
  threadId: string,
  title: string,
): Promise<void> {
  await globalThis.services.db
    .update(chatThreads)
    .set({ title })
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
  createdAt: string;
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
    summaries?: SummaryEntry[];
    createdAt: string;
  }>;
  latestSessionId: string | null;
  /** Runs not yet reflected in chatMessages (active, failed, etc.) */
  unsavedRuns: UnsavedRun[];
}> {
  // Check if thread has a persisted sessionId (populated by chat callback)
  const [threadRow] = await globalThis.services.db
    .select({ sessionId: chatThreads.sessionId })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);

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

  let sessionId: string | null = threadRow?.sessionId ?? null;
  const savedRunIds = new Set<string>();

  if (!sessionId) {
    // Fallback: walk runs for legacy threads (pre-migration, sessionId is NULL)
    for (const run of runs) {
      if (hasAgentSessionId(run.result)) {
        sessionId = run.result.agentSessionId;
        savedRunIds.add(run.runId);
      }
      if (!sessionId && run.continuedFromSessionId) {
        sessionId = run.continuedFromSessionId;
      }
    }
  } else {
    // For threads with persisted sessionId, still mark saved runs
    for (const run of runs) {
      if (hasAgentSessionId(run.result)) {
        savedRunIds.add(run.runId);
      }
    }
  }

  // Load messages from the session
  let messages: StoredChatMessage[] = [];

  if (sessionId) {
    messages = await getChatMessagesForSession(sessionId, userId);

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
    .filter((r) => {
      return !savedRunIds.has(r.runId);
    })
    .map((r) => {
      return {
        runId: r.runId,
        status: r.status,
        prompt: r.prompt,
        error: r.error,
        createdAt: r.createdAt.toISOString(),
      };
    });

  return {
    chatMessages: enrichedMessages,
    latestSessionId: sessionId,
    unsavedRuns,
  };
}

/**
 * Get previous conversation messages for a thread, suitable for title generation.
 * Returns up to 10 recent messages (role + content only).
 */
export async function getChatThreadContext(
  threadId: string,
  userId: string,
): Promise<TitleContextMessage[]> {
  const [threadRow] = await globalThis.services.db
    .select({ sessionId: chatThreads.sessionId })
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .limit(1);

  if (!threadRow?.sessionId) {
    return [];
  }

  const messages = await getChatMessagesForSession(threadRow.sessionId, userId);
  return messages.slice(-10).map((m) => {
    return {
      role: m.role,
      content: m.content,
    };
  });
}
