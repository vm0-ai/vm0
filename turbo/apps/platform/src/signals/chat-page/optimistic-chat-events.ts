import { command, computed, state } from "ccstate";
import type { ChatEvent } from "@vm0/api-contracts/contracts/chat-threads";
import { parseChatEventBodyBlocks } from "./chat-event-body-blocks.ts";
import type { OptimisticChatEvent } from "./chat-event-types.ts";
import type { ParsedBodyBlock } from "./parse-body-blocks.ts";

export type OptimisticUserMessageAssociation = "run" | "queue";

export interface OptimisticChatEventInput {
  threadId: string;
  event: OptimisticChatEvent;
  optimisticUserMessageAssociation?: OptimisticUserMessageAssociation;
}

export interface OptimisticChatEventEntry extends OptimisticChatEventInput {
  parsedBodyBlocks: ParsedBodyBlock[];
}

export function createOptimisticChatEventEntry(
  input: OptimisticChatEventInput,
): OptimisticChatEventEntry {
  return {
    ...input,
    parsedBodyBlocks: parseChatEventBodyBlocks(input.event),
  };
}

const internalOptimisticChatEvents$ = state<OptimisticChatEventEntry[]>([]);

export function createOptimisticChatEventsForThread(threadId: string) {
  return computed((get): OptimisticChatEventEntry[] => {
    return get(internalOptimisticChatEvents$).filter((entry) => {
      return entry.threadId === threadId;
    });
  });
}
export const appendOptimisticChatEvent$ = command(
  ({ set }, entry: OptimisticChatEventEntry) => {
    set(internalOptimisticChatEvents$, (prev) => {
      const next = prev.filter((item) => {
        return item.event.id !== entry.event.id;
      });
      return [...next, entry];
    });
  },
);

export const reconcileOptimisticChatEvents$ = command(
  (
    { set },
    { threadId, events }: { threadId: string; events: readonly ChatEvent[] },
  ) => {
    if (events.length === 0) {
      return;
    }
    const serverIds = new Set(
      events.map((event) => {
        return event.id;
      }),
    );
    set(internalOptimisticChatEvents$, (prev) => {
      return prev.filter((entry) => {
        return entry.threadId !== threadId || !serverIds.has(entry.event.id);
      });
    });
  },
);
