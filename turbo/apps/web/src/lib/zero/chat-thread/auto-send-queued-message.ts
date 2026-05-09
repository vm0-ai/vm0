import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { initServices } from "../../init-services";
import {
  buildWebAttachFilesPrompt,
  buildWebChatIncompleteContext,
  buildWebChatPrompt,
  type WebChatIncompleteRound,
} from "../integration-prompt";
import { createZeroRun, fetchZeroAgentForRun } from "../zero-run-service";
import { getApiUrl, generateCallbackSecret } from "../../infra/callback";
import type { ChatCallbackPayload } from "../../infra/callback/callback-payloads";
import { publishUserSignal } from "../../infra/realtime/client";
import { logger } from "../../shared/logger";
import {
  getIncompleteRoundsSinceLastSuccess,
  getChatThreadIdForRun,
  getLatestSessionIdForThread,
  publishThreadListChanged,
} from "./chat-message-service";
import { resolveAttachFileUrls } from "./chat-thread-service";

const log = logger("auto-send-queued");

type QueuedUserMessage = {
  id: string;
  content: string | null;
  attachFiles: string[] | null;
  modelProviderId: string | null;
  modelProviderType: string | null;
  modelProviderCredentialScope: string | null;
  selectedModel: string | null;
};

async function nextQueuedUserMessage(
  threadId: string,
): Promise<QueuedUserMessage | null> {
  const [message] = await globalThis.services.db
    .select({
      id: chatMessages.id,
      content: chatMessages.content,
      attachFiles: chatMessages.attachFiles,
      modelProviderId: chatThreads.modelProviderId,
      modelProviderType: chatThreads.modelProviderType,
      modelProviderCredentialScope: chatThreads.modelProviderCredentialScope,
      selectedModel: chatThreads.selectedModel,
    })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.chatThreadId))
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        eq(chatMessages.role, "user"),
        isNull(chatMessages.archivedAt),
        isNull(chatMessages.runId),
        isNull(chatMessages.revokesMessageId),
        sql`NOT EXISTS (
          SELECT 1
          FROM ${chatMessages} AS revoker
          WHERE revoker.revokes_message_id = ${chatMessages.id}
        )`,
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
    .limit(1);

  return message ?? null;
}

function buildAppendSystemPrompt(incompleteContext: string): string {
  return [buildWebChatPrompt(), incompleteContext]
    .filter((part) => {
      return typeof part === "string" && part.length > 0;
    })
    .join("\n\n");
}

function groupIncompleteRoundsByRunId(
  rows: Awaited<ReturnType<typeof getIncompleteRoundsSinceLastSuccess>>,
): WebChatIncompleteRound[] {
  const byRunId = new Map<string, WebChatIncompleteRound>();
  const order: string[] = [];
  for (const row of rows) {
    let round = byRunId.get(row.runId);
    if (!round) {
      round = {
        runId: row.runId,
        status: row.runStatus,
        messages: [],
      };
      byRunId.set(row.runId, round);
      order.push(row.runId);
    }
    round.messages.push({
      role: row.role,
      content: row.content,
      error: row.error,
      attachFiles: row.attachFiles,
    });
  }
  return order.map((id) => {
    return byRunId.get(id)!;
  });
}

/**
 * After a chat run reaches a terminal state, claim the oldest unassociated user
 * message in the thread and dispatch it as the next run. The queued message row
 * itself is immutable; claiming appends a new user row that revokes the queued
 * row and carries the new run_id.
 */
export async function autoSendQueuedMessageOnRunComplete(input: {
  runId: string;
  agentId: string;
  apiStartTime: number;
}): Promise<void> {
  initServices();
  const { runId, agentId, apiStartTime } = input;

  const chatThread = await getChatThreadIdForRun(runId);
  if (!chatThread) {
    return;
  }
  const { chatThreadId: threadId, userId } = chatThread;

  const queuedMessage = await nextQueuedUserMessage(threadId);
  if (!queuedMessage) {
    return;
  }

  const [sessionId, incompleteRows] = await Promise.all([
    getLatestSessionIdForThread(threadId),
    getIncompleteRoundsSinceLastSuccess(threadId),
  ]);
  const incompleteContext = buildWebChatIncompleteContext(
    groupIncompleteRoundsByRunId(incompleteRows),
  );

  const agent = await fetchZeroAgentForRun(agentId);
  if (!agent) {
    log.warn("Auto-send aborted: agent not found", { threadId, agentId });
    return;
  }

  const resolvedAttachFiles =
    queuedMessage.attachFiles && queuedMessage.attachFiles.length > 0
      ? await resolveAttachFileUrls(userId, queuedMessage.attachFiles)
      : [];
  const attachFiles =
    resolvedAttachFiles.length > 0
      ? resolvedAttachFiles
      : (queuedMessage.attachFiles ?? []).map((id) => {
          return {
            id,
            filename: id,
            contentType: "application/octet-stream",
            size: 0,
            url: "",
          };
        });
  const content = queuedMessage.content ?? "";
  const fullPrompt =
    attachFiles.length === 0
      ? content
      : `${content}\n\n${buildWebAttachFilesPrompt(attachFiles)}`;

  const chatCallback: {
    url: string;
    secret: string;
    payload: ChatCallbackPayload;
  } = {
    url: getApiUrl() + "/api/internal/callbacks/chat",
    secret: generateCallbackSecret(),
    payload: { threadId, agentId },
  };

  const run = await createZeroRun({
    userId,
    prompt: fullPrompt,
    agentId,
    sessionId,
    triggerSource: "web",
    apiStartTime,
    appendSystemPrompt: buildAppendSystemPrompt(incompleteContext),
    callbacks: [chatCallback],
    chatThreadId: threadId,
    modelProvider: queuedMessage.modelProviderType ?? undefined,
    modelProviderId: queuedMessage.modelProviderId ?? undefined,
    modelProviderCredentialScope:
      queuedMessage.modelProviderCredentialScope ?? undefined,
    selectedModelOverride: queuedMessage.selectedModel ?? undefined,
    preloadedAgent: agent,
  });

  const claimed = await globalThis.services.db
    .insert(chatMessages)
    .values({
      chatThreadId: threadId,
      role: "user",
      content: queuedMessage.content,
      runId: run.runId,
      attachFiles: queuedMessage.attachFiles,
      revokesMessageId: queuedMessage.id,
    })
    .onConflictDoNothing({ target: chatMessages.revokesMessageId })
    .returning({ id: chatMessages.id });

  if (claimed.length === 0) {
    await globalThis.services.db
      .update(agentRuns)
      .set({ status: "cancelled", error: "Queued message already claimed" })
      .where(eq(agentRuns.id, run.runId));
    log.warn("Auto-send created a run for an already-claimed message", {
      threadId,
      runId: run.runId,
      userMessageId: queuedMessage.id,
    });
    return;
  }

  await publishUserSignal([userId], `chatThreadMessageCreated:${threadId}`);
  await publishUserSignal([userId], `chatThreadRunCreated:${threadId}`);
  await publishThreadListChanged(userId);
}
