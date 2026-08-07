import { command, computed, state } from "ccstate";
import type { ChatEvent } from "@vm0/api-contracts/contracts/chat-threads";
import { logger } from "../log.ts";
import { parseChatEventBodyBlocks } from "./chat-event-body-blocks.ts";
import type {
  OptimisticChatEvent,
  OptimisticUserMessageAssociation,
} from "./chat-event-types.ts";
import type { ParsedBodyBlock } from "./parse-body-blocks.ts";

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
    parsedBodyBlocks: parseChatEventBodyBlocks(input.event, input.threadId),
  };
}

const L = logger("OptimisticChatEvents");

const internalOptimisticChatEvents$ = state<OptimisticChatEventEntry[]>([]);

function pendingUserMessages(
  entries: readonly OptimisticChatEventEntry[],
  threadId: string,
): { eventId: string; association: OptimisticUserMessageAssociation }[] {
  return entries.flatMap((entry) => {
    const association = entry.optimisticUserMessageAssociation;
    return entry.threadId === threadId && association !== undefined
      ? [{ eventId: entry.event.id, association }]
      : [];
  });
}

export function createOptimisticChatEventsForThread(threadId: string) {
  return computed((get): OptimisticChatEventEntry[] => {
    return get(internalOptimisticChatEvents$).filter((entry) => {
      return entry.threadId === threadId;
    });
  });
}
export const appendOptimisticChatEvent$ = command(
  ({ get, set }, entry: OptimisticChatEventEntry) => {
    set(internalOptimisticChatEvents$, (prev) => {
      const next = prev.filter((item) => {
        return item.event.id !== entry.event.id;
      });
      return [...next, entry];
    });
    L.debug("optimistic event appended", {
      threadId: entry.threadId,
      eventId: entry.event.id,
      association: entry.optimisticUserMessageAssociation ?? null,
      pendingUserMessages: pendingUserMessages(
        get(internalOptimisticChatEvents$),
        entry.threadId,
      ),
    });
  },
);

export const reconcileOptimisticChatEvents$ = command(
  (
    { get, set },
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
    const before = pendingUserMessages(
      get(internalOptimisticChatEvents$),
      threadId,
    );
    set(internalOptimisticChatEvents$, (prev) => {
      return prev.filter((entry) => {
        return entry.threadId !== threadId || !serverIds.has(entry.event.id);
      });
    });
    const after = pendingUserMessages(
      get(internalOptimisticChatEvents$),
      threadId,
    );
    L.debug("optimistic events reconciled", {
      threadId,
      serverEventCount: events.length,
      // A pending user message that no server event ever matches keeps
      // `hasOptimisticUserMessage$` true, which pins the thread to the tail.
      pendingUserMessagesBefore: before,
      pendingUserMessagesAfter: after,
      serverEventIds: events.slice(0, 10).map((event) => {
        return event.id;
      }),
    });
  },
);
