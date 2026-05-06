import type { ChatThread } from "../agent-chat.ts";

export function createPendingChatThread(
  threadId: string,
  agentId: string,
  pendingRunId?: string,
): ChatThread {
  const activeRunIds: string[] = pendingRunId ? [pendingRunId] : [];
  const activeRuns: { id: string; status: string }[] = pendingRunId
    ? [{ id: pendingRunId, status: "pending" }]
    : [];
  return {
    id: threadId,
    title: null,
    agentId,
    latestSessionId: null,
    lastReadMessageId: null,
    latestSessionProviderType: null,
    activeRunIds,
    activeRuns,
    isLegacySession: false,
    draftContent: null,
    draftAttachments: null,
    pendingMessage: null,
    modelProviderId: null,
    selectedModel: null,
  };
}
