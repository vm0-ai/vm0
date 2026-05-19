import { eq, asc } from "drizzle-orm";
import {
  chatMessages,
  type ChatMessageAttachFiles,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { publishUserSignal } from "../../infra/realtime/client";
import { recordChatSpan, type ChatSpanDimensions } from "../../infra/metrics";
import { CHAT_REQUEST_OPS, timed } from "./request-span-ops";

function effectiveChatMessageRunId() {
  return chatMessages.runId;
}

const messageRowProjection = {
  id: chatMessages.id,
  role: chatMessages.role,
  content: chatMessages.content,
  runId: effectiveChatMessageRunId(),
  error: chatMessages.error,
  sequenceNumber: chatMessages.sequenceNumber,
  createdAt: chatMessages.createdAt,
  runStatus: agentRuns.status,
  runError: agentRuns.error,
  attachFiles: chatMessages.attachFiles,
  revokesMessageId: chatMessages.revokesMessageId,
  interruptsRunId: chatMessages.interruptsRunId,
  goalRemainingTurns: chatMessages.goalRemainingTurns,
  goalOriginMessageId: chatMessages.goalOriginMessageId,
} as const;

type MessageRow = {
  id: string;
  role: string;
  content: string | null;
  runId: string | null;
  error: string | null;
  sequenceNumber: number | null;
  createdAt: Date;
  runStatus: string | null;
  runError: string | null;
  attachFiles: ChatMessageAttachFiles | null;
  revokesMessageId: string | null;
  interruptsRunId: string | null;
  goalRemainingTurns: number | null;
  goalOriginMessageId: string | null;
};

/**
 * Insert a chat message (user row on send, or assistant row on terminal
 * callback / direct integration) and fan out the `chatThreadMessageCreated`
 * realtime signal to the thread owner.
 *
 * When `id` is provided, it is used as the primary key so the client can
 * reconcile an optimistic row by matching on id. Otherwise the DB default
 * (`defaultRandom()`) is used.
 *
 * Publishing the signal here (instead of at each call site) ensures the
 * cancel / failure paths — which insert via the chat callback — also notify
 * the frontend, so the cancelled message surfaces without a page refresh.
 */
export async function insertChatMessage(params: {
  chatThreadId: string;
  userId: string;
  role: "user" | "assistant";
  content: string | null;
  runId: string | null;
  error?: string | null;
  attachFiles?: ChatMessageAttachFiles;
  revokesMessageId?: string | null;
  interruptsRunId?: string | null;
  goalRemainingTurns?: number | null;
  goalOriginMessageId?: string | null;
  id?: string;
  spanDims?: ChatSpanDimensions;
}): Promise<{ id: string; createdAt: Date }> {
  const { result: insertedRow, ms: insertMs } = await timed(async () => {
    return globalThis.services.db
      .insert(chatMessages)
      .values({
        ...(params.id ? { id: params.id } : {}),
        chatThreadId: params.chatThreadId,
        role: params.role,
        content: params.content,
        runId: params.runId,
        revokesMessageId: params.revokesMessageId ?? null,
        interruptsRunId: params.interruptsRunId ?? null,
        goalRemainingTurns: params.goalRemainingTurns ?? null,
        goalOriginMessageId: params.goalOriginMessageId ?? null,
        error: params.error ?? null,
        attachFiles: params.attachFiles ?? null,
      })
      .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });
  });
  const [row] = insertedRow;
  if (params.spanDims) {
    recordChatSpan(
      CHAT_REQUEST_OPS.insert_chat_message_insert,
      insertMs,
      params.spanDims,
    );
  }

  if (!row) {
    throw new Error("Failed to insert chat message");
  }

  const { ms: publishSignalMs } = await timed(async () => {
    await publishUserSignal(
      [params.userId],
      `chatThreadMessageCreated:${params.chatThreadId}`,
    );
  });
  if (params.spanDims) {
    recordChatSpan(
      CHAT_REQUEST_OPS.insert_chat_message_publish_signal,
      publishSignalMs,
      params.spanDims,
    );
  }

  const { ms: publishListMs } = await timed(async () => {
    await publishThreadListChanged(params.userId);
  });
  if (params.spanDims) {
    recordChatSpan(
      CHAT_REQUEST_OPS.insert_chat_message_publish_list,
      publishListMs,
      params.spanDims,
    );
  }

  return row;
}

/**
 * Resolve the chat_thread_id and owner user_id for a run from the zero_runs
 * table. Returns null when the run is not tied to a chat thread (e.g.,
 * non-chat triggers like cron/schedule), so event consumers can silently skip it.
 */
async function getChatThreadIdForRun(
  runId: string,
): Promise<{ chatThreadId: string; userId: string } | null> {
  const [row] = await globalThis.services.db
    .select({
      chatThreadId: zeroRuns.chatThreadId,
      userId: chatThreads.userId,
    })
    .from(zeroRuns)
    .innerJoin(chatThreads, eq(zeroRuns.chatThreadId, chatThreads.id))
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  if (!row?.chatThreadId) return null;
  return { chatThreadId: row.chatThreadId, userId: row.userId };
}

/**
 * Emit the `chatThreadRunUpdated:${threadId}` realtime signal so chat
 * subscribers reload the thread when a run transitions to a terminal state.
 *
 * Reads the authoritative `zero_runs.chatThreadId` mapping rather than
 * reverse-looking-up `chat_messages`, so the signal fires even when no
 * assistant row has been written yet (e.g., cancel before the first token).
 *
 * No-op for non-chat runs (cron / schedule triggers).
 */
export async function publishChatThreadRunUpdated(
  runId: string,
): Promise<void> {
  const chatThread = await getChatThreadIdForRun(runId);
  if (!chatThread) return;
  await publishUserSignal(
    [chatThread.userId],
    `chatThreadRunUpdated:${chatThread.chatThreadId}`,
  );
  await publishThreadListChanged(chatThread.userId);
}

/**
 * Fire the user-level "thread list shape changed" signal. The sidebar
 * subscribes to this topic and reloads the full list on any delivery —
 * payload is intentionally empty because the server is authoritative and
 * the client already has a cheap list endpoint to re-fetch.
 */
export async function publishThreadListChanged(userId: string): Promise<void> {
  await publishUserSignal([userId], "threadListChanged");
}

/**
 * Get all message events for a thread with run status, ordered by createdAt ASC.
 *
 * Unbounded — only test seeders and legacy readers that truly need the full
 * thread should use this. This intentionally does not apply visibility/revoke
 * filters: chat message APIs are the append-only event stream, and clients
 * derive their own display projection.
 */
export async function getMessagesByThreadId(
  chatThreadId: string,
): Promise<MessageRow[]> {
  return globalThis.services.db
    .select(messageRowProjection)
    .from(chatMessages)
    .leftJoin(agentRuns, eq(agentRuns.id, chatMessages.runId))
    .where(eq(chatMessages.chatThreadId, chatThreadId))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.sequenceNumber));
}
