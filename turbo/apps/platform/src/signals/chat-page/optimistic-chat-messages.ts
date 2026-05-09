import { command, computed, state } from "ccstate";
import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";

export type OptimisticUserMessageAssociation = "run" | "queue";

export interface OptimisticChatMessageEntry {
  threadId: string;
  message: PagedChatMessage;
  optimisticUserMessageAssociation?: OptimisticUserMessageAssociation;
}

const internalOptimisticChatMessages$ = state<OptimisticChatMessageEntry[]>([]);

export function createOptimisticChatMessagesForThread(threadId: string) {
  return computed((get): OptimisticChatMessageEntry[] => {
    return get(internalOptimisticChatMessages$).filter((entry) => {
      return entry.threadId === threadId;
    });
  });
}

export function createQueuedOptimisticUserMessagesForThread(threadId: string) {
  return computed((get): OptimisticChatMessageEntry[] => {
    const entries = get(internalOptimisticChatMessages$).filter((entry) => {
      return entry.threadId === threadId;
    });
    const recalledIds = new Set(
      entries.flatMap((entry) => {
        const { message } = entry;
        return message.role === "user" &&
          message.runId === undefined &&
          message.revokesMessageId !== undefined
          ? [message.revokesMessageId]
          : [];
      }),
    );
    return entries.filter((entry) => {
      const { message } = entry;
      return (
        entry.optimisticUserMessageAssociation === "queue" &&
        message.role === "user" &&
        message.runId === undefined &&
        message.revokesMessageId === undefined &&
        !recalledIds.has(message.id)
      );
    });
  });
}

export const appendOptimisticChatMessage$ = command(
  ({ set }, entry: OptimisticChatMessageEntry) => {
    set(internalOptimisticChatMessages$, (prev) => {
      const next = prev.filter((item) => {
        return item.message.id !== entry.message.id;
      });
      return [...next, entry];
    });
  },
);

export const reconcileOptimisticChatMessages$ = command(
  (
    { set },
    {
      threadId,
      messages,
    }: { threadId: string; messages: readonly PagedChatMessage[] },
  ) => {
    if (messages.length === 0) {
      return;
    }
    const serverIds = new Set(
      messages.map((message) => {
        return message.id;
      }),
    );
    set(internalOptimisticChatMessages$, (prev) => {
      return prev.filter((entry) => {
        return entry.threadId !== threadId || !serverIds.has(entry.message.id);
      });
    });
  },
);
