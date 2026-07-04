import { command, computed, state } from "ccstate";
import {
  zeroMemoryContract,
  type MemoryDetailResponse,
} from "@vm0/api-contracts/contracts/zero-memory";
import {
  zeroMemoryActivityContract,
  type MemoryActivityResponse,
} from "@vm0/api-contracts/contracts/zero-memory-activity";
import {
  zeroMemoryDevRefreshContract,
  type MemoryDevRefreshResponse,
} from "@vm0/api-contracts/contracts/zero-memory-dev-refresh";
import {
  zeroRelationshipsContract,
  type RelationshipSearchResponse,
} from "@vm0/api-contracts/contracts/zero-relationships";
import { toast } from "@vm0/ui/components/ui/sonner";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

export type MemoryRelationshipFilter =
  | "all"
  | "people"
  | "organizations"
  | "open-loops";

export type MemoryTab = "updates" | "relationships" | "raw";

export const MEMORY_ACTIVITY_RECENT_LIMIT = 7;

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

const internalMemoryRelationshipSearch$ = state("");
const internalMemoryRelationshipFilter$ =
  state<MemoryRelationshipFilter>("all");
const internalSelectedMemoryRelationshipId$ = state<string | null>(null);

export const memoryRelationshipSearch$ = computed((get) => {
  return get(internalMemoryRelationshipSearch$);
});

export const setMemoryRelationshipSearch$ = command(
  ({ set }, search: string) => {
    set(internalMemoryRelationshipSearch$, search);
  },
);

export const memoryRelationshipFilter$ = computed((get) => {
  return get(internalMemoryRelationshipFilter$);
});

export const setMemoryRelationshipFilter$ = command(
  ({ set }, filter: MemoryRelationshipFilter) => {
    set(internalMemoryRelationshipFilter$, filter);
  },
);

export const selectedMemoryRelationshipId$ = computed((get) => {
  return get(internalSelectedMemoryRelationshipId$);
});

export const setSelectedMemoryRelationshipId$ = command(
  ({ set }, relationshipId: string) => {
    set(internalSelectedMemoryRelationshipId$, relationshipId);
  },
);

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
    const result = await accept(
      client.get({ query: { limit: MEMORY_ACTIVITY_RECENT_LIMIT } }),
      [200],
    );
    return result.body;
  },
);

export const memoryRelationships$ = computed(
  async (get): Promise<RelationshipSearchResponse> => {
    const search = get(memoryRelationshipSearch$).trim();
    const client = get(zeroClient$)(zeroRelationshipsContract);
    const result = await accept(
      client.search({
        query: {
          q: search.length > 0 ? search : undefined,
          limit: 20,
        },
      }),
      [200],
    );
    return result.body;
  },
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
