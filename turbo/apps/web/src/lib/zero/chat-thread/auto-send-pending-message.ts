import { eq } from "drizzle-orm";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import type { AttachFile } from "@vm0/api-contracts/contracts/chat-threads";
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
import {
  getChatThreadIdForRun,
  insertChatMessage,
} from "./chat-message-service";

const log = logger("auto-send-pending");

/**
 * After the previous run on `threadId` reaches a terminal state, claim the
 * pending message and dispatch it as a fresh run. No-op when the thread has
 * no queued message.
 *
 * Atomicity: read-then-clear is best-effort — if a queue/recall lands between
 * the SELECT and the UPDATE the row may be dropped or duplicated. Race
 * resolution is intentionally deferred (per Epic note); the user-facing
 * symptom is rare enough that the simpler implementation is preferred over
 * a transactional read-modify-write.
 *
 * Skips the auth / model-selection / lock / eager-pin / title-generation
 * stages of the public send route — those guards are appropriate for a
 * user request, but the queued payload was already validated when it was
 * appended, and the thread's pinned model is the authoritative choice.
 *
 * Resolves the thread id from `zero_runs` rather than trusting the callback
 * payload, so a stale or non-chat callback (e.g. cron / schedule trigger
 * carrying a synthetic threadId) does not blow up the chat_threads SELECT
 * with an invalid-uuid error.
 */
export async function autoSendPendingMessageOnRunComplete(input: {
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

  const [thread] = await globalThis.services.db
    .select({
      pendingMessageContent: chatThreads.pendingMessageContent,
      pendingMessageAttachments: chatThreads.pendingMessageAttachments,
      pendingMessageCreatedAt: chatThreads.pendingMessageCreatedAt,
      modelProviderId: chatThreads.modelProviderId,
      selectedModel: chatThreads.selectedModel,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);

  if (!thread || !thread.pendingMessageCreatedAt) {
    return;
  }

  await globalThis.services.db
    .update(chatThreads)
    .set({
      pendingMessageContent: null,
      pendingMessageAttachments: null,
      pendingMessageCreatedAt: null,
      pendingMessageUpdatedAt: null,
    })
    .where(eq(chatThreads.id, threadId));

  const content = thread.pendingMessageContent ?? "";
  const persisted = thread.pendingMessageAttachments ?? [];
  const attachFiles: AttachFile[] = persisted.map((a) => {
    return {
      id: a.id,
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
    };
  });

  const agent = await fetchZeroAgentForRun(agentId);
  if (!agent) {
    log.warn("Auto-send aborted: agent not found", { threadId, agentId });
    return;
  }

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
    modelProviderId: thread.modelProviderId ?? undefined,
    selectedModelOverride: thread.selectedModel ?? undefined,
    preloadedAgent: agent,
  });

  await insertChatMessage({
    chatThreadId: threadId,
    userId,
    role: "user",
    content,
    runId: run.runId,
    attachFiles:
      attachFiles.length > 0
        ? attachFiles.map((f) => {
            return f.id;
          })
        : undefined,
  });

  await publishUserSignal([userId], `chatThreadRunCreated:${threadId}`);
  await publishUserSignal(
    [userId],
    `chatThreadPendingMessageChanged:${threadId}`,
  );
}
