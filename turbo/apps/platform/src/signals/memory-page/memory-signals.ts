import { command, computed, state } from "ccstate";
import {
  zeroMemoryContract,
  type MemoryDetailResponse,
} from "@vm0/api-contracts/contracts/zero-memory";
import {
  MEMORY_ACTIVITY_DEFAULT_LIMIT,
  zeroMemoryActivityContract,
  type MemoryActivityResponse,
} from "@vm0/api-contracts/contracts/zero-memory-activity";
import {
  zeroMemoryDevRefreshContract,
  type MemoryDevRefreshResponse,
} from "@vm0/api-contracts/contracts/zero-memory-dev-refresh";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { settle, withCleanup } from "../utils.ts";

export type MemoryTab = "updates" | "raw";

const internalSelectedMemoryFilePath$ = state<string | null>(null);

export const selectedMemoryFilePath$ = computed((get) => {
  return get(internalSelectedMemoryFilePath$);
});

export const setSelectedMemoryFilePath$ = command(
  ({ set }, filePath: string | null) => {
    set(internalSelectedMemoryFilePath$, filePath);
  },
);

const internalMemoryTab$ = state<MemoryTab>("updates");

export const memoryTab$ = computed((get) => {
  return get(internalMemoryTab$);
});

export const setMemoryTab$ = command(({ set }, tab: MemoryTab) => {
  set(internalMemoryTab$, tab);
});

type MemoryDevRefreshState =
  | { readonly status: "idle" }
  | { readonly status: "refreshing" }
  | { readonly status: "success"; readonly message: string }
  | { readonly status: "error"; readonly message: string };

const memoryActivityReload$ = state(0);

const internalMemoryDevRefreshState$ = state<MemoryDevRefreshState>({
  status: "idle",
});

export const memoryDevRefreshState$ = computed((get) => {
  return get(internalMemoryDevRefreshState$);
});

// Per-item expand state for the Updates timeline, keyed by a stable item key.
// Mirrors the keyed-record ephemeral UI state pattern used elsewhere in the
// platform (e.g. view-component-state) since `useState` is restricted here.
const internalExpandedMemoryItems$ = state<Record<string, boolean>>({});

export const expandedMemoryItems$ = computed((get) => {
  return get(internalExpandedMemoryItems$);
});

export const toggleMemoryItemExpanded$ = command(({ set }, key: string) => {
  set(internalExpandedMemoryItems$, (current) => {
    return { ...current, [key]: !current[key] };
  });
});

export const memoryDetail$ = computed(
  async (get): Promise<MemoryDetailResponse> => {
    const client = get(zeroClient$)(zeroMemoryContract);
    const result = await accept(client.get(), [200], { toast: false });
    return result.body;
  },
);

export const memoryActivity$ = computed(
  async (get): Promise<MemoryActivityResponse> => {
    get(memoryActivityReload$);
    const client = get(zeroClient$)(zeroMemoryActivityContract);
    const result = await accept(client.get(), [200], { toast: false });
    return result.body;
  },
);

type MemoryActivityEntries = MemoryActivityResponse["entries"];

interface MemoryActivityExtraPage {
  readonly entries: MemoryActivityEntries;
  readonly nextCursor: string | null;
}

interface MemoryActivityPaginationState {
  readonly key: string;
  readonly pages: readonly MemoryActivityExtraPage[];
}

interface MemoryActivityLoadMoreErrorState {
  readonly key: string;
  readonly message: string;
}

function paginationKey(page: MemoryActivityResponse): string {
  const tailVersionId =
    page.entries[page.entries.length - 1]?.toVersionId ?? "";
  return `${page.nextCursor ?? ""}:${tailVersionId}`;
}

function matchesPaginationKey<T extends { readonly key: string }>(
  state: T | null,
  key: string,
): state is T {
  return state !== null && state.key === key;
}

const extraMemoryActivityPages$ = state<MemoryActivityPaginationState | null>(
  null,
);
const loadingMoreMemoryActivity$ = state<string | null>(null);
const loadMoreMemoryActivityError$ =
  state<MemoryActivityLoadMoreErrorState | null>(null);

function memoryDevRefreshMessage(body: MemoryDevRefreshResponse): string {
  if ("skipped" in body) {
    return "No memory summaries changed";
  }
  if (body.summarized === 1) {
    return "Refreshed 1 memory summary";
  }
  return `Refreshed ${body.summarized} memory summaries`;
}

const reloadMemoryActivity$ = command(({ set }): void => {
  set(extraMemoryActivityPages$, null);
  set(loadMoreMemoryActivityError$, null);
  set(memoryActivityReload$, (current) => {
    return current + 1;
  });
});

export const refreshMemoryDevSummaries$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    if (get(internalMemoryDevRefreshState$).status === "refreshing") {
      return;
    }

    set(internalMemoryDevRefreshState$, { status: "refreshing" });

    const client = get(zeroClient$)(zeroMemoryDevRefreshContract);
    const settled = await withCleanup(
      settle(
        accept(client.refresh({ fetchOptions: { signal } }), [200], {
          toast: false,
        }),
        signal,
      ),
      () => {
        set(internalMemoryDevRefreshState$, (current) => {
          return current.status === "refreshing"
            ? ({ status: "idle" } satisfies MemoryDevRefreshState)
            : current;
        });
      },
    );
    signal.throwIfAborted();

    if (!settled.ok) {
      set(internalMemoryDevRefreshState$, {
        status: "error",
        message:
          settled.error instanceof Error
            ? settled.error.message
            : "Memory refresh failed",
      });
      return;
    }

    set(internalMemoryDevRefreshState$, {
      status: "success",
      message: memoryDevRefreshMessage(settled.value.body),
    });
    set(reloadMemoryActivity$);
  },
);

export const memoryActivityExtraEntries$ = computed(async (get) => {
  const firstPage = await get(memoryActivity$);
  const key = paginationKey(firstPage);
  const state = get(extraMemoryActivityPages$);
  if (!matchesPaginationKey(state, key)) {
    return [];
  }
  return state.pages.flatMap((page) => {
    return page.entries;
  });
});

export const memoryActivityHasLoadedExtraPages$ = computed(async (get) => {
  const firstPage = await get(memoryActivity$);
  const state = get(extraMemoryActivityPages$);
  return matchesPaginationKey(state, paginationKey(firstPage));
});

export const memoryActivityExtraHasMore$ = computed(async (get) => {
  const firstPage = await get(memoryActivity$);
  const key = paginationKey(firstPage);
  const state = get(extraMemoryActivityPages$);
  if (!matchesPaginationKey(state, key) || state.pages.length === 0) {
    return false;
  }
  return state.pages[state.pages.length - 1]!.nextCursor !== null;
});

export const memoryActivityLatestCursor$ = computed(async (get) => {
  const firstPage = await get(memoryActivity$);
  const key = paginationKey(firstPage);
  const state = get(extraMemoryActivityPages$);
  if (!matchesPaginationKey(state, key) || state.pages.length === 0) {
    return null;
  }
  return state.pages[state.pages.length - 1]!.nextCursor;
});

export const memoryActivityLoadingMore$ = computed(async (get) => {
  const firstPage = await get(memoryActivity$);
  return get(loadingMoreMemoryActivity$) === paginationKey(firstPage);
});

export const memoryActivityLoadMoreError$ = computed(async (get) => {
  const firstPage = await get(memoryActivity$);
  const key = paginationKey(firstPage);
  const error = get(loadMoreMemoryActivityError$);
  return matchesPaginationKey(error, key) ? error.message : null;
});

export const loadMoreMemoryActivity$ = command(
  async ({ get, set }, cursor: string, signal: AbortSignal): Promise<void> => {
    const firstPage = await get(memoryActivity$);
    signal.throwIfAborted();
    const key = paginationKey(firstPage);
    if (get(loadingMoreMemoryActivity$) === key) {
      return;
    }

    set(loadingMoreMemoryActivity$, key);
    set(loadMoreMemoryActivityError$, null);

    const client = get(zeroClient$)(zeroMemoryActivityContract);
    const settled = await withCleanup(
      settle(
        accept(
          client.get({
            query: {
              cursor,
              limit: MEMORY_ACTIVITY_DEFAULT_LIMIT,
            },
            fetchOptions: { signal },
          }),
          [200],
          { toast: false },
        ),
        signal,
      ),
      () => {
        set(loadingMoreMemoryActivity$, (current) => {
          return current === key ? null : current;
        });
      },
    );
    signal.throwIfAborted();

    if (!settled.ok) {
      set(loadMoreMemoryActivityError$, {
        key,
        message:
          settled.error instanceof Error
            ? settled.error.message
            : "Failed to load more updates",
      });
      return;
    }

    set(extraMemoryActivityPages$, (current) => {
      const pages = matchesPaginationKey(current, key) ? current.pages : [];
      return {
        key,
        pages: [
          ...pages,
          {
            entries: settled.value.body.entries,
            nextCursor: settled.value.body.nextCursor,
          },
        ],
      };
    });
  },
);
