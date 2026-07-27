import { command, computed, state } from "ccstate";
import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";
import { parseMessageBodyBlocks } from "./chat-message-body-blocks.ts";
import type { OptimisticChatMessage } from "./chat-message-types.ts";
import type { ParsedBodyBlock } from "./parse-body-blocks.ts";

export type OptimisticUserMessageAssociation = "run" | "queue";

export interface OptimisticChatMessageInput {
  threadId: string;
  message: OptimisticChatMessage;
  optimisticUserMessageAssociation?: OptimisticUserMessageAssociation;
}

export interface OptimisticChatMessageEntry extends OptimisticChatMessageInput {
  parsedBodyBlocks: ParsedBodyBlock[];
}

export function createOptimisticChatMessageEntry(
  input: OptimisticChatMessageInput,
): OptimisticChatMessageEntry {
  return {
    ...input,
    parsedBodyBlocks: parseMessageBodyBlocks(input.message),
  };
}

const internalOptimisticChatMessages$ = state<OptimisticChatMessageEntry[]>([]);

export function createOptimisticChatMessagesForThread(threadId: string) {
  return computed((get): OptimisticChatMessageEntry[] => {
    return get(internalOptimisticChatMessages$).filter((entry) => {
      return entry.threadId === threadId;
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
