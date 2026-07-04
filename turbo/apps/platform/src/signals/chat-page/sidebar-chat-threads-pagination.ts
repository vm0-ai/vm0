import { command, computed } from "ccstate";
import { loadMoreEventDrivenChatThreads$ } from "./chat-thread-event-sourcing.ts";

export const loadMoreSidebarChatThreads$ = command(
  ({ set }, _cursor: string, _signal: AbortSignal) => {
    set(loadMoreEventDrivenChatThreads$);
  },
);

export const sidebarChatThreadsExtraThreads$ = computed(() => {
  return [];
});

export const sidebarChatThreadsHasLoadedExtraPages$ = computed(() => {
  return false;
});

export const sidebarChatThreadsLatestCursor$ = computed(() => {
  return null;
});

export const sidebarChatThreadsExtraHasMore$ = computed(() => {
  return false;
});
