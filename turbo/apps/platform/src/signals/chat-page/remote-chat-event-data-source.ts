import { command } from "ccstate";
import {
  chatThreadMarkReadContract,
  type ChatEvent,
} from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { logger } from "../log.ts";
import {
  applyUnreadSnapshot$,
  recordOptimisticReadMark$,
} from "./sidebar-unread-threads.ts";
import { listChatEvents } from "./chat-event-api.ts";

const L = logger("ChatEventRemote");
export const CHAT_EVENTS_PAGE_LIMIT = 50;

interface ListEventsAfterArgs {
  readonly threadId: string;
  readonly sinceSeqId: number | undefined;
}

interface ListEventsBeforeArgs {
  readonly threadId: string;
  readonly beforeSeqId: number;
}

interface MarkReadArgs {
  readonly threadId: string;
}

export const listEventsAfter$ = command(
  async (
    { get },
    { threadId, sinceSeqId }: ListEventsAfterArgs,
    signal: AbortSignal,
  ): Promise<ChatEvent[]> => {
    const events = await listChatEvents(
      get(zeroClient$),
      threadId,
      { sinceSeqId, limit: CHAT_EVENTS_PAGE_LIMIT },
      signal,
    );
    signal.throwIfAborted();
    L.debug("listEventsAfter$", {
      threadId,
      sinceSeqId,
      count: events.length,
      runEvents: events.flatMap((event) => {
        if (!event.runId) {
          return [];
        }
        return [{ id: event.id, runId: event.runId }];
      }),
    });
    return events;
  },
);

export const listEventsBefore$ = command(
  async (
    { get },
    { threadId, beforeSeqId }: ListEventsBeforeArgs,
    signal: AbortSignal,
  ): Promise<ChatEvent[]> => {
    return await listChatEvents(
      get(zeroClient$),
      threadId,
      { beforeSeqId, limit: CHAT_EVENTS_PAGE_LIMIT },
      signal,
    );
  },
);

export const markChatThreadRead$ = command(
  async (
    { get, set },
    { threadId }: MarkReadArgs,
    signal: AbortSignal,
  ): Promise<string | null> => {
    set(recordOptimisticReadMark$, threadId);
    const client = get(zeroClient$)(chatThreadMarkReadContract);
    const result = await accept(
      client.markRead({
        params: { id: threadId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(applyUnreadSnapshot$, result.body.unreads);
    return result.body.lastReadAt;
  },
);
