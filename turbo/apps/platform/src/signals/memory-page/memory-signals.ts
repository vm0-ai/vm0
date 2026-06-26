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
import { toast } from "@vm0/ui/components/ui/sonner";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

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

const memoryActivityReload$ = state(0);

// Per-entry and per-item expand state for the Updates timeline, keyed by stable
// activity keys. Mirrors the keyed-record ephemeral UI state pattern used
// elsewhere in the platform since `useState` is restricted here.
const internalExpandedMemoryEntries$ = state<Record<string, boolean>>({});
const internalExpandedMemoryItems$ = state<Record<string, boolean>>({});

export const expandedMemoryEntries$ = computed((get) => {
  return get(internalExpandedMemoryEntries$);
});

export const expandedMemoryItems$ = computed((get) => {
  return get(internalExpandedMemoryItems$);
});

export const toggleMemoryEntryExpanded$ = command(({ set }, key: string) => {
  set(internalExpandedMemoryEntries$, (current) => {
    return { ...current, [key]: !current[key] };
  });
});

export const toggleMemoryItemExpanded$ = command(({ set }, key: string) => {
  set(internalExpandedMemoryItems$, (current) => {
    return { ...current, [key]: !current[key] };
  });
});

export const memoryDetail$ = computed(
  async (get): Promise<MemoryDetailResponse> => {
    const client = get(zeroClient$)(zeroMemoryContract);
    const result = await accept(client.get(), [200]);
    return result.body;
  },
);

export const memoryActivity$ = computed(
  async (get): Promise<MemoryActivityResponse> => {
    get(memoryActivityReload$);
    const client = get(zeroClient$)(zeroMemoryActivityContract);
    const result = await accept(client.get(), [200]);
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
  set(memoryActivityReload$, (current) => {
    return current + 1;
  });
});

export const refreshMemoryDevSummaries$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const client = get(zeroClient$)(zeroMemoryDevRefreshContract);
    const result = await accept(
      client.refresh({ fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    toast.success(memoryDevRefreshMessage(result.body));
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

export const loadMoreMemoryActivity$ = command(
  async ({ get, set }, cursor: string, signal: AbortSignal): Promise<void> => {
    const firstPage = await get(memoryActivity$);
    signal.throwIfAborted();
    const key = paginationKey(firstPage);

    const client = get(zeroClient$)(zeroMemoryActivityContract);
    const result = await accept(
      client.get({
        query: {
          cursor,
          limit: MEMORY_ACTIVITY_DEFAULT_LIMIT,
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    set(extraMemoryActivityPages$, (current) => {
      const pages = matchesPaginationKey(current, key) ? current.pages : [];
      return {
        key,
        pages: [
          ...pages,
          {
            entries: result.body.entries,
            nextCursor: result.body.nextCursor,
          },
        ],
      };
    });
  },
);
