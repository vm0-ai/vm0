import { command, computed, state } from "ccstate";
import {
  chatThreadsContract,
  type ChatThreadListItem,
} from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { settle } from "../utils.ts";

interface ExtraPage {
  readonly threads: readonly ChatThreadListItem[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

/**
 * Extra cursor-paginated pages loaded by the /chats All Threads page on top of
 * the initial first-page response from `chatThreadsFirstPage$`. Kept module-
 * private and exposed only via computed selectors + commands so that loading
 * more on the /chats page never re-renders the sidebar (which remains capped
 * at the bounded first page).
 */
const extraPagesState$ = state<readonly ExtraPage[]>([]);
const loadingMoreState$ = state(false);
const loadMoreErrorState$ = state<string | null>(null);

export const allChatThreadsLoadingMore$ = computed((get) => {
  return get(loadingMoreState$);
});

export const allChatThreadsLoadMoreError$ = computed((get) => {
  return get(loadMoreErrorState$);
});

export const loadMoreAllChatThreads$ = command(
  async ({ get, set }, cursor: string, signal: AbortSignal): Promise<void> => {
    const agentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    if (!agentId) {
      return;
    }
    set(loadingMoreState$, true);
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
    set(loadingMoreState$, false);

    if (!settled.ok) {
      set(
        loadMoreErrorState$,
        settled.error instanceof Error
          ? settled.error.message
          : "Failed to load more chats",
      );
      return;
    }

    set(extraPagesState$, (prev) => {
      return [
        ...prev,
        {
          threads: settled.value.body.threads,
          hasMore: settled.value.body.hasMore,
          nextCursor: settled.value.body.nextCursor,
        },
      ];
    });
  },
);

/**
 * Flat list of all extra threads loaded beyond the first page, in order.
 * The first page itself is read directly from `chatThreadsFirstPage$` by the
 * page component.
 */
export const allChatThreadsExtraThreads$ = computed((get) => {
  const pages = get(extraPagesState$);
  return pages.flatMap((p) => {
    return p.threads;
  });
});

/**
 * The most recent cursor advancement — either from the last extra page or
 * null if no extra pages are loaded (caller falls back to first-page cursor).
 */
export const allChatThreadsLatestCursor$ = computed((get) => {
  const pages = get(extraPagesState$);
  return pages.length > 0 ? pages[pages.length - 1]!.nextCursor : null;
});

/**
 * Whether any of the extra pages indicates more rows remain. Independent of
 * the first-page hasMore flag — that one only matters when no extra pages
 * have been loaded yet.
 */
export const allChatThreadsExtraHasMore$ = computed((get) => {
  const pages = get(extraPagesState$);
  return pages.length > 0 ? pages[pages.length - 1]!.hasMore : false;
});
