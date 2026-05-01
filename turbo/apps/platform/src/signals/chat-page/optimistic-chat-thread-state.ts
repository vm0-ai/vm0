import { command, computed, state } from "ccstate";
import { createChatThreadSignals } from "./create-chat-thread.ts";

export type OptimisticChatPane = "main" | "sidebar";

export interface PendingChatThread {
  pane: OptimisticChatPane;
  threadId: string;
  agentId: string;
  createdAt: string;
  running: boolean;
  pendingThread: ReturnType<typeof createChatThreadSignals>;
  settleResult: Promise<void>;
}

interface OptimisticChatThreads {
  main: PendingChatThread | null;
  sidebar: PendingChatThread | null;
}

// eslint-disable-next-line ccstate/no-export-state -- shared with optimistic-chat-thread-page.ts, internal is the intent
export const internalOptimisticChatThreads$ = state<OptimisticChatThreads>({
  main: null,
  sidebar: null,
});

export const optimisticChatThread$ = computed((get) => {
  return get(internalOptimisticChatThreads$).main;
});

export const sidebarOptimisticChatThread$ = computed((get) => {
  return get(internalOptimisticChatThreads$).sidebar;
});

export const clearMatchingOptimisticChatThread$ = command(
  ({ set }, pending: PendingChatThread) => {
    set(internalOptimisticChatThreads$, (current) => {
      if (current[pending.pane] !== pending) {
        return current;
      }
      return { ...current, [pending.pane]: null };
    });
  },
);
