import { command } from "ccstate";

import { authenticatedIdentity$ } from "../auth.ts";
import { queryChatEventSharedDatabase$ } from "../shared-database.ts";
import { allUnreadThreadIds$ } from "./chat-thread-indicators.ts";

const BACKGROUND_UNREAD_THREAD_LIMIT = 10;

export const prewarmSharedUnreadChatEvents$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const [{ userId, orgId }, unreadThreadIds] = await Promise.all([
      get(authenticatedIdentity$),
      get(allUnreadThreadIds$),
    ]);
    signal.throwIfAborted();
    await Promise.all(
      Array.from(unreadThreadIds)
        .slice(0, BACKGROUND_UNREAD_THREAD_LIMIT)
        .map((threadId) => {
          return set(
            queryChatEventSharedDatabase$,
            {
              dataKey: {
                kind: "chat-event",
                userId,
                orgId,
                threadId,
              },
              afterSeqId: null,
              consistency: "catch-up",
            },
            signal,
          );
        }),
    );
  },
);
