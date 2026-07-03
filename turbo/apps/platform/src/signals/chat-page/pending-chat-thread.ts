import type { ChatThread } from "../agent-chat.ts";
import { nowDate } from "../../lib/time.ts";

export function createPendingChatThread(
  threadId: string,
  agentId: string,
  pendingRunId?: string,
  computerUseHostId: string | null = null,
): ChatThread {
  const activeRunIds: string[] = pendingRunId ? [pendingRunId] : [];
  const createdAt = nowDate().toISOString();
  return {
    id: threadId,
    title: null,
    agentId,
    createdAt,
    updatedAt: createdAt,
    lastReadMessageId: null,
    lastReadAt: null,
    lastMessageAt: createdAt,
    pinnedAt: null,
    activeRunIds,
    isLegacySession: false,
    draftContent: null,
    draftAttachments: null,
    modelProviderId: null,
    selectedModel: null,
    computerUseHostId,
  };
}
