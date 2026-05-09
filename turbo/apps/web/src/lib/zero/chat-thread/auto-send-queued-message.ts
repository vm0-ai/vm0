import { and, asc, eq, isNull } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { userMessageRun } from "@vm0/db/schema/user-message-run";
import { initServices } from "../../init-services";
import {
  buildWebAttachFilesPrompt,
  buildWebChatPrompt,
} from "../integration-prompt";
import { createZeroRun, fetchZeroAgentForRun } from "../zero-run-service";
import { getApiUrl, generateCallbackSecret } from "../../infra/callback";
import type { ChatCallbackPayload } from "../../infra/callback/callback-payloads";
import { publishUserSignal } from "../../infra/realtime/client";
import { logger } from "../../shared/logger";
import { getChatThreadIdForRun } from "./chat-message-service";
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
    .leftJoin(userMessageRun, eq(userMessageRun.userMessageId, chatMessages.id))
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        eq(chatMessages.role, "user"),
        isNull(chatMessages.archivedAt),
        isNull(userMessageRun.userMessageId),
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
    .limit(1);

  return message ?? null;
}

/**
 * After a chat run reaches a terminal state, claim the oldest user message in
 * the thread that has no user_message_run row yet and dispatch it as the next
 * run. The queued message row itself is immutable; claiming appends only the
 * user_message_run association.
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
    triggerSource: "web",
    apiStartTime,
    appendSystemPrompt: buildWebChatPrompt(),
    callbacks: [chatCallback],
    chatThreadId: threadId,
    modelProvider: queuedMessage.modelProviderType ?? undefined,
    modelProviderId: queuedMessage.modelProviderId ?? undefined,
    modelProviderCredentialScope:
      queuedMessage.modelProviderCredentialScope ?? undefined,
    selectedModelOverride: queuedMessage.selectedModel ?? undefined,
    preloadedAgent: agent,
  });

  const linked = await globalThis.services.db
    .insert(userMessageRun)
    .values({
      userMessageId: queuedMessage.id,
      runId: run.runId,
    })
    .onConflictDoNothing({ target: userMessageRun.userMessageId })
    .returning({ userMessageId: userMessageRun.userMessageId });

  if (linked.length === 0) {
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

  await publishUserSignal([userId], `chatThreadRunCreated:${threadId}`);
}
