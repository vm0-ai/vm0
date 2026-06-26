import { command, computed, state } from "ccstate";
import {
  chatThreadsContract,
  type ChatThreadListItem,
} from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { reloadChatThreadsCounter$ } from "../chat-thread-list-reload.ts";

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

const extraPagesState$ = state<PaginationState | null>(null);

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

export const loadMoreSidebarChatThreads$ = command(
  async ({ get, set }, cursor: string, signal: AbortSignal): Promise<void> => {
    const agentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    const reloadKey = get(reloadChatThreadsCounter$);
    if (!agentId) {
      return;
    }

    const key = { agentId, reloadKey };

    const client = get(zeroClient$)(chatThreadsContract);
    const result = await accept(
      client.list({
        query: { agentId, cursor },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

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
            threads: result.body.threads,
            hasMore: result.body.hasMore,
            nextCursor: result.body.nextCursor,
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
