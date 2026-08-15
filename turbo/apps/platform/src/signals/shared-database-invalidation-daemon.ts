import { command } from "ccstate";
import { logger } from "./log.ts";
import { syncActiveChatEvents$ } from "./chat-page/chat-event-signal-registry.ts";
import { syncEventDrivenChatThreads$ } from "./chat-page/chat-thread-event-sourcing.ts";
import { takeSharedDatabaseInvalidations$ } from "./shared-database-invalidation-queue.ts";
import { setLoop } from "./utils.ts";

const L = logger("SharedDatabaseInvalidationDaemon");

export const runSharedDatabaseInvalidationDaemon$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await setLoop(
      async (loopSignal) => {
        const dataKeys = await set(
          takeSharedDatabaseInvalidations$,
          loopSignal,
        );
        loopSignal.throwIfAborted();
        const results = await Promise.allSettled(
          dataKeys.map((dataKey) => {
            return dataKey.kind === "chat-event"
              ? set(syncActiveChatEvents$, dataKey.threadId, loopSignal)
              : set(syncEventDrivenChatThreads$, loopSignal);
          }),
        );
        loopSignal.throwIfAborted();
        for (const result of results) {
          if (result.status === "rejected") {
            L.warn("shared database invalidation sync failed", result.reason);
          }
        }
        return false;
      },
      0,
      signal,
      { retryTransientErrors: false },
    );
  },
);
