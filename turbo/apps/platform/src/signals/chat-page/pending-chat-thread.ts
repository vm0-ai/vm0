import type { CodexServiceTier } from "@vm0/api-contracts/contracts/chat-threads";
import type { ChatThread } from "../agent-chat.ts";
import { nowDate } from "../../lib/time.ts";

export function createPendingChatThread(args: {
  readonly threadId: string;
  readonly agentId: string;
  readonly pendingRunId?: string;
  readonly computerUseHostId?: string | null;
  readonly selectedModel?: string | null;
  readonly codexServiceTier?: CodexServiceTier | null;
}): ChatThread {
  const {
    threadId,
    agentId,
    pendingRunId,
    selectedModel = null,
    codexServiceTier = null,
  } = args;
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
    selectedModel,
    codexServiceTier,
    computerUseHostId: args.computerUseHostId ?? null,
  };
}
