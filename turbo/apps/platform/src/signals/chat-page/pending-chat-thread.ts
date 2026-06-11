import type { ChatThread } from "../agent-chat.ts";

export function createPendingChatThread(
  threadId: string,
  agentId: string,
  pendingRunId?: string,
  computerUseHostId: string | null = null,
): ChatThread {
  const activeRunIds: string[] = pendingRunId ? [pendingRunId] : [];
  return {
    id: threadId,
    title: null,
    agentId,
    lastReadMessageId: null,
    activeRunIds,
    isLegacySession: false,
    draftContent: null,
    draftAttachments: null,
    modelProviderId: null,
    selectedModel: null,
    computerUseHostId,
  };
}
