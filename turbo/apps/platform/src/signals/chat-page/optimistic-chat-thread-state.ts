import { command, computed, state } from "ccstate";
import type { createChatThreadSignals } from "./create-chat-thread.ts";

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

const internalOptimisticChatThreads$ = state<OptimisticChatThreads>({
  main: null,
  sidebar: null,
});

export const optimisticChatThread$ = computed((get) => {
  return get(internalOptimisticChatThreads$).main;
});

export const sidebarOptimisticChatThread$ = computed((get) => {
  return get(internalOptimisticChatThreads$).sidebar;
});

export const optimisticChatThreadByPane$ = computed((get) => {
  return (pane: OptimisticChatPane): PendingChatThread | null => {
    return get(internalOptimisticChatThreads$)[pane];
  };
});

export const allPendingChatThreads$ = computed((get): PendingChatThread[] => {
  return Object.values(get(internalOptimisticChatThreads$)).filter(
    (thread): thread is PendingChatThread => {
      return thread !== null;
    },
  );
});

export const registerOptimisticChatThread$ = command(
  ({ set }, pending: PendingChatThread) => {
    set(internalOptimisticChatThreads$, (current) => {
      return { ...current, [pending.pane]: pending };
    });
  },
);

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
