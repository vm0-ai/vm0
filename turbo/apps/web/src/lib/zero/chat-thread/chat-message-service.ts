import { eq, asc } from "drizzle-orm";
import {
  chatMessages,
  type ChatMessageAttachFiles,
} from "@vm0/db/schema/chat-message";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { publishUserSignal } from "../../infra/realtime/client";

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
};

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
