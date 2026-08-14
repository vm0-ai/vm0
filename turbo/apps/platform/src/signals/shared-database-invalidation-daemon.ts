import { command } from "ccstate";
import { logger } from "./log.ts";
import { syncActiveChatEvents$ } from "./chat-page/chat-event-signal-registry.ts";
import { syncEventDrivenChatThreads$ } from "./chat-page/chat-thread-event-sourcing.ts";
import { takeSharedDatabaseInvalidations$ } from "./shared-database-invalidation-queue.ts";

const L = logger("SharedDatabaseInvalidationDaemon");

export const runSharedDatabaseInvalidationDaemon$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    while (!signal.aborted) {
      const dataKeys = await set(takeSharedDatabaseInvalidations$, signal);
      signal.throwIfAborted();
      const results = await Promise.allSettled(
        dataKeys.map((dataKey) => {
          return dataKey.kind === "chat-event"
            ? set(syncActiveChatEvents$, dataKey.threadId, signal)
            : set(syncEventDrivenChatThreads$, signal);
        }),
      );
      signal.throwIfAborted();
      for (const result of results) {
        if (result.status === "rejected") {
          L.warn("shared database invalidation sync failed", result.reason);
        }
      }
    }
  },
);
