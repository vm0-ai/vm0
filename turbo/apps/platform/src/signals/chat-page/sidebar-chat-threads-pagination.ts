import { command, computed, state } from "ccstate";
import {
  chatThreadsContract,
  type ChatThreadListItem,
} from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { reloadChatThreadsCounter$ } from "../chat-thread-list-reload.ts";
import { settle } from "../utils.ts";

interface ExtraPage {
  readonly threads: readonly ChatThreadListItem[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

interface PaginationState {
  readonly agentId: string;
  readonly reloadKey: number;
  readonly pages: readonly ExtraPage[];
}

interface PaginationKey {
  readonly agentId: string;
  readonly reloadKey: number;
}

interface LoadMoreErrorState extends PaginationKey {
  readonly message: string;
}

const extraPagesState$ = state<PaginationState | null>(null);
const loadingMoreState$ = state<PaginationKey | null>(null);
const loadMoreErrorState$ = state<LoadMoreErrorState | null>(null);

function matchesKey<T extends PaginationKey>(
  state: T | null,
  agentId: string | null,
  reloadKey: number,
): state is T {
  return (
    !!state &&
    !!agentId &&
    state.agentId === agentId &&
    state.reloadKey === reloadKey
  );
}

export const sidebarChatThreadsLoadingMore$ = computed(async (get) => {
  const agentId = await get(currentChatAgentId$);
  const reloadKey = get(reloadChatThreadsCounter$);
  return matchesKey(get(loadingMoreState$), agentId, reloadKey);
});

export const sidebarChatThreadsLoadMoreError$ = computed(async (get) => {
  const agentId = await get(currentChatAgentId$);
  const reloadKey = get(reloadChatThreadsCounter$);
  const error = get(loadMoreErrorState$);
  return matchesKey(error, agentId, reloadKey) ? error.message : null;
});

export const loadMoreSidebarChatThreads$ = command(
  async ({ get, set }, cursor: string, signal: AbortSignal): Promise<void> => {
    const agentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    const reloadKey = get(reloadChatThreadsCounter$);
    if (!agentId) {
      return;
    }
    if (matchesKey(get(loadingMoreState$), agentId, reloadKey)) {
      return;
    }

    const key = { agentId, reloadKey };
    set(loadingMoreState$, key);
    set(loadMoreErrorState$, null);

    const client = get(zeroClient$)(chatThreadsContract);
    const settled = await settle(
      accept(
        client.list({
          query: { agentId, cursor },
          fetchOptions: { signal },
        }),
        [200],
      ),
      signal,
    );

    set(loadingMoreState$, (current) => {
      return matchesKey(current, agentId, reloadKey) ? null : current;
    });

    if (!settled.ok) {
      set(loadMoreErrorState$, {
        ...key,
        message:
          settled.error instanceof Error
            ? settled.error.message
            : "Failed to load more chats",
      });
      return;
    }

    const latestAgentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    const latestReloadKey = get(reloadChatThreadsCounter$);
    if (latestAgentId !== agentId || latestReloadKey !== reloadKey) {
      return;
    }

    set(extraPagesState$, (prev) => {
      const pages = matchesKey(prev, agentId, reloadKey) ? prev.pages : [];
      return {
        ...key,
        pages: [
          ...pages,
          {
            threads: settled.value.body.threads,
            hasMore: settled.value.body.hasMore,
            nextCursor: settled.value.body.nextCursor,
          },
        ],
      };
    });
  },
);

export const sidebarChatThreadsExtraThreads$ = computed(async (get) => {
  const agentId = await get(currentChatAgentId$);
  const reloadKey = get(reloadChatThreadsCounter$);
  const state = get(extraPagesState$);
  if (!matchesKey(state, agentId, reloadKey)) {
    return [];
  }
  return state.pages.flatMap((p) => {
    return p.threads;
  });
});

export const sidebarChatThreadsHasLoadedExtraPages$ = computed(async (get) => {
  const agentId = await get(currentChatAgentId$);
  const reloadKey = get(reloadChatThreadsCounter$);
  const state = get(extraPagesState$);
  return matchesKey(state, agentId, reloadKey) && state.pages.length > 0;
});

export const sidebarChatThreadsLatestCursor$ = computed(async (get) => {
  const agentId = await get(currentChatAgentId$);
  const reloadKey = get(reloadChatThreadsCounter$);
  const state = get(extraPagesState$);
  if (!matchesKey(state, agentId, reloadKey) || state.pages.length === 0) {
    return null;
  }
  return state.pages[state.pages.length - 1]!.nextCursor;
});

export const sidebarChatThreadsExtraHasMore$ = computed(async (get) => {
  const agentId = await get(currentChatAgentId$);
  const reloadKey = get(reloadChatThreadsCounter$);
  const state = get(extraPagesState$);
  if (!matchesKey(state, agentId, reloadKey) || state.pages.length === 0) {
    return false;
  }
  return state.pages[state.pages.length - 1]!.hasMore;
});
