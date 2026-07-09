import { command, computed, state } from "ccstate";
import {
  zeroMemoryContract,
  type MemoryDetailResponse,
  type MemoryInjectionPreviewResponse,
  type MemoryRecallItemKind,
  type MemoryRecallResponse,
  type MemorySourceDetailResponse,
  type MemorySourceListResponse,
  type MemorySourceProvider,
  type SlackMemoryBackfillRequest,
  type SlackMemoryStatusResponse,
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
  RELATIONSHIP_SEARCH_DEFAULT_LIMIT,
  type GmailRelationshipBackfillRequest,
  type GmailRelationshipStatusResponse,
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

export type MemorySourceProviderFilter = "all" | MemorySourceProvider;

export type MemoryRecallKindFilter = "all" | MemoryRecallItemKind;

export type MemoryTab =
  | "updates"
  | "injection"
  | "recall"
  | "relationships"
  | "sources"
  | "raw";

export const MEMORY_ACTIVITY_RECENT_LIMIT = 7;

function defaultGmailRelationshipBackfillRequest(): GmailRelationshipBackfillRequest {
  return {
    days: 180,
    includeArchived: true,
    includeSent: true,
  };
}

function defaultSlackMemoryBackfillRequest(): SlackMemoryBackfillRequest {
  return {
    days: 180,
    includePublicChannels: true,
    includePrivateChannels: true,
    includeDirectMessages: true,
  };
}

function relationshipSearchQueryFilter(filter: MemoryRelationshipFilter): {
  readonly entityType?: "person" | "organization";
  readonly itemKind?: "open_loop";
} {
  switch (filter) {
    case "people": {
      return { entityType: "person" };
    }
    case "organizations": {
      return { entityType: "organization" };
    }
    case "open-loops": {
      return { itemKind: "open_loop" };
    }
    case "all": {
      return {};
    }
  }
}

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
const internalMemoryRelationshipPage$ = state(1);
const internalMemoryRelationshipLimit$ = state(
  RELATIONSHIP_SEARCH_DEFAULT_LIMIT,
);
const internalSelectedMemoryRelationshipId$ = state<string | null>(null);
const internalMemoryRelationshipsReload$ = state(0);
const internalGmailRelationshipStatusReload$ = state(0);
const internalGmailRelationshipBackfillDialogOpen$ = state(false);
const internalGmailRelationshipBackfillRequest$ =
  state<GmailRelationshipBackfillRequest>(
    defaultGmailRelationshipBackfillRequest(),
  );

const internalMemoryRecallQuery$ = state("");
const internalSubmittedMemoryRecallQuery$ = state("");
const internalMemoryRecallKindFilter$ = state<MemoryRecallKindFilter>("all");
const internalMemoryRecallLimit$ = state(10);
const internalMemoryRecallReload$ = state(0);
const internalMemoryInjectionPrompt$ = state("");
const internalSubmittedMemoryInjectionPrompt$ = state("");
const internalMemoryInjectionReload$ = state(0);

export const memoryRecallQuery$ = computed((get) => {
  return get(internalMemoryRecallQuery$);
});

export const setMemoryRecallQuery$ = command(({ set }, query: string) => {
  set(internalMemoryRecallQuery$, query);
});

export const submittedMemoryRecallQuery$ = computed((get) => {
  return get(internalSubmittedMemoryRecallQuery$);
});

export const submitMemoryRecall$ = command(({ get, set }) => {
  const query = get(internalMemoryRecallQuery$).trim();
  const previousQuery = get(internalSubmittedMemoryRecallQuery$).trim();
  set(internalSubmittedMemoryRecallQuery$, query);
  if (query === previousQuery) {
    set(internalMemoryRecallReload$, (current) => {
      return current + 1;
    });
  }
});

export const memoryRecallKindFilter$ = computed((get) => {
  return get(internalMemoryRecallKindFilter$);
});

export const setMemoryRecallKindFilter$ = command(
  ({ set }, filter: MemoryRecallKindFilter) => {
    set(internalMemoryRecallKindFilter$, filter);
  },
);

export const memoryRecallLimit$ = computed((get) => {
  return get(internalMemoryRecallLimit$);
});

export const setMemoryRecallLimit$ = command(({ set }, limit: number) => {
  set(internalMemoryRecallLimit$, limit);
});

export const memoryInjectionPrompt$ = computed((get) => {
  return get(internalMemoryInjectionPrompt$);
});

export const setMemoryInjectionPrompt$ = command(({ set }, prompt: string) => {
  set(internalMemoryInjectionPrompt$, prompt);
});

export const submittedMemoryInjectionPrompt$ = computed((get) => {
  return get(internalSubmittedMemoryInjectionPrompt$);
});

export const submitMemoryInjectionPreview$ = command(({ get, set }) => {
  const prompt = get(internalMemoryInjectionPrompt$).trim();
  const previousPrompt = get(internalSubmittedMemoryInjectionPrompt$).trim();
  set(internalSubmittedMemoryInjectionPrompt$, prompt);
  if (prompt === previousPrompt) {
    set(internalMemoryInjectionReload$, (current) => {
      return current + 1;
    });
  }
});

export const memoryRelationshipSearch$ = computed((get) => {
  return get(internalMemoryRelationshipSearch$);
});

export const setMemoryRelationshipSearch$ = command(
  ({ set }, search: string) => {
    set(internalMemoryRelationshipSearch$, search);
    set(internalMemoryRelationshipPage$, 1);
    set(internalSelectedMemoryRelationshipId$, null);
  },
);

export const memoryRelationshipFilter$ = computed((get) => {
  return get(internalMemoryRelationshipFilter$);
});

export const setMemoryRelationshipFilter$ = command(
  ({ set }, filter: MemoryRelationshipFilter) => {
    set(internalMemoryRelationshipFilter$, filter);
    set(internalMemoryRelationshipPage$, 1);
    set(internalSelectedMemoryRelationshipId$, null);
  },
);

export const memoryRelationshipPage$ = computed((get) => {
  return get(internalMemoryRelationshipPage$);
});

export const memoryRelationshipLimit$ = computed((get) => {
  return get(internalMemoryRelationshipLimit$);
});

export const memoryRelationshipHasPrev$ = computed((get) => {
  return get(internalMemoryRelationshipPage$) > 1;
});

export const goToNextMemoryRelationshipPage$ = command(
  ({ set }, totalPages: number) => {
    set(internalMemoryRelationshipPage$, (current) => {
      return Math.min(totalPages, current + 1);
    });
    set(internalSelectedMemoryRelationshipId$, null);
  },
);

export const goToPrevMemoryRelationshipPage$ = command(({ set }) => {
  set(internalMemoryRelationshipPage$, (current) => {
    return Math.max(1, current - 1);
  });
  set(internalSelectedMemoryRelationshipId$, null);
});

export const goForwardTwoMemoryRelationshipPages$ = command(
  ({ set }, totalPages: number) => {
    set(internalMemoryRelationshipPage$, (current) => {
      return Math.min(totalPages, current + 2);
    });
    set(internalSelectedMemoryRelationshipId$, null);
  },
);

export const goBackTwoMemoryRelationshipPages$ = command(({ set }) => {
  set(internalMemoryRelationshipPage$, (current) => {
    return Math.max(1, current - 2);
  });
  set(internalSelectedMemoryRelationshipId$, null);
});

export const setMemoryRelationshipRowsPerPage$ = command(
  ({ set }, limit: number) => {
    set(internalMemoryRelationshipLimit$, limit);
    set(internalMemoryRelationshipPage$, 1);
    set(internalSelectedMemoryRelationshipId$, null);
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

export const reloadMemoryRelationships$ = command(({ set }) => {
  set(internalMemoryRelationshipsReload$, (current) => {
    return current + 1;
  });
});

export const reloadGmailRelationshipStatus$ = command(({ set }) => {
  set(internalGmailRelationshipStatusReload$, (current) => {
    return current + 1;
  });
});

export const gmailRelationshipBackfillDialogOpen$ = computed((get) => {
  return get(internalGmailRelationshipBackfillDialogOpen$);
});

export const setGmailRelationshipBackfillDialogOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalGmailRelationshipBackfillDialogOpen$, open);
    if (open) {
      set(
        internalGmailRelationshipBackfillRequest$,
        defaultGmailRelationshipBackfillRequest(),
      );
    }
  },
);

export const gmailRelationshipBackfillRequest$ = computed((get) => {
  return get(internalGmailRelationshipBackfillRequest$);
});

export const updateGmailRelationshipBackfillRequest$ = command(
  ({ set }, patch: Partial<GmailRelationshipBackfillRequest>) => {
    set(internalGmailRelationshipBackfillRequest$, (current) => {
      return { ...current, ...patch };
    });
  },
);

const memoryActivityReload$ = state(0);
const internalMemorySourceProviderFilter$ =
  state<MemorySourceProviderFilter>("all");
const internalMemorySourcePage$ = state(1);
const internalMemorySourceLimit$ = state(50);
const internalMemorySourcesReload$ = state(0);
const internalSelectedMemorySourceId$ = state<string | null>(null);
const internalSlackMemoryStatusReload$ = state(0);
const internalSlackMemoryBackfillDialogOpen$ = state(false);
const internalSlackMemoryBackfillRequest$ = state<SlackMemoryBackfillRequest>(
  defaultSlackMemoryBackfillRequest(),
);

export const memorySourceProviderFilter$ = computed((get) => {
  return get(internalMemorySourceProviderFilter$);
});

export const selectedMemorySourceId$ = computed((get) => {
  return get(internalSelectedMemorySourceId$);
});

export const setSelectedMemorySourceId$ = command(
  ({ set }, sourceId: string | null) => {
    set(internalSelectedMemorySourceId$, sourceId);
  },
);

export const setMemorySourceProviderFilter$ = command(
  ({ set }, filter: MemorySourceProviderFilter) => {
    set(internalMemorySourceProviderFilter$, filter);
    set(internalMemorySourcePage$, 1);
  },
);

export const memorySourcePage$ = computed((get) => {
  return get(internalMemorySourcePage$);
});

export const memorySourceLimit$ = computed((get) => {
  return get(internalMemorySourceLimit$);
});

export const memorySourceHasPrev$ = computed((get) => {
  return get(internalMemorySourcePage$) > 1;
});

export const goToNextMemorySourcePage$ = command(
  ({ set }, totalPages: number) => {
    set(internalMemorySourcePage$, (current) => {
      return Math.min(totalPages, current + 1);
    });
  },
);

export const goToPrevMemorySourcePage$ = command(({ set }) => {
  set(internalMemorySourcePage$, (current) => {
    return Math.max(1, current - 1);
  });
});

export const goForwardTwoMemorySourcePages$ = command(
  ({ set }, totalPages: number) => {
    set(internalMemorySourcePage$, (current) => {
      return Math.min(totalPages, current + 2);
    });
  },
);

export const goBackTwoMemorySourcePages$ = command(({ set }) => {
  set(internalMemorySourcePage$, (current) => {
    return Math.max(1, current - 2);
  });
});

export const setMemorySourceRowsPerPage$ = command(({ set }, limit: number) => {
  set(internalMemorySourceLimit$, limit);
  set(internalMemorySourcePage$, 1);
});

export const reloadMemorySources$ = command(({ set }) => {
  set(internalMemorySourcesReload$, (current) => {
    return current + 1;
  });
});

export const reloadSlackMemoryStatus$ = command(({ set }) => {
  set(internalSlackMemoryStatusReload$, (current) => {
    return current + 1;
  });
});

export const slackMemoryBackfillDialogOpen$ = computed((get) => {
  return get(internalSlackMemoryBackfillDialogOpen$);
});

export const setSlackMemoryBackfillDialogOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalSlackMemoryBackfillDialogOpen$, open);
    if (open) {
      set(
        internalSlackMemoryBackfillRequest$,
        defaultSlackMemoryBackfillRequest(),
      );
    }
  },
);

export const slackMemoryBackfillRequest$ = computed((get) => {
  return get(internalSlackMemoryBackfillRequest$);
});

export const updateSlackMemoryBackfillRequest$ = command(
  ({ set }, patch: Partial<SlackMemoryBackfillRequest>) => {
    set(internalSlackMemoryBackfillRequest$, (current) => {
      return { ...current, ...patch };
    });
  },
);

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

export const memorySources$ = computed(
  async (get): Promise<MemorySourceListResponse> => {
    get(internalMemorySourcesReload$);
    const providerFilter = get(memorySourceProviderFilter$);
    const page = get(memorySourcePage$);
    const limit = get(memorySourceLimit$);
    const client = get(zeroClient$)(zeroMemoryContract);
    const result = await accept(
      client.sources({
        query: {
          provider: providerFilter === "all" ? undefined : providerFilter,
          page,
          limit,
        },
      }),
      [200],
    );
    return result.body;
  },
);

export const selectedMemorySourceDetail$ = computed(
  async (get): Promise<MemorySourceDetailResponse | null> => {
    const sourceId = get(selectedMemorySourceId$);
    if (!sourceId) {
      return null;
    }

    const client = get(zeroClient$)(zeroMemoryContract);
    const result = await accept(client.source({ params: { sourceId } }), [200]);
    return result.body;
  },
);

export const memoryRelationships$ = computed(
  async (get): Promise<RelationshipSearchResponse> => {
    get(internalMemoryRelationshipsReload$);
    const search = get(memoryRelationshipSearch$).trim();
    const filter = get(memoryRelationshipFilter$);
    const page = get(memoryRelationshipPage$);
    const limit = get(memoryRelationshipLimit$);
    const client = get(zeroClient$)(zeroRelationshipsContract);
    const result = await accept(
      client.search({
        query: {
          q: search.length > 0 ? search : undefined,
          page,
          limit,
          ...relationshipSearchQueryFilter(filter),
        },
      }),
      [200],
    );
    return result.body;
  },
);

export const memoryRecallResults$ = computed(
  async (get): Promise<MemoryRecallResponse | null> => {
    get(internalMemoryRecallReload$);
    const query = get(submittedMemoryRecallQuery$).trim();
    if (query.length === 0) {
      return null;
    }

    const kindFilter = get(memoryRecallKindFilter$);
    const limit = get(memoryRecallLimit$);
    const client = get(zeroClient$)(zeroMemoryContract);
    const result = await accept(
      client.recall({
        query: {
          q: query,
          kind: kindFilter === "all" ? undefined : kindFilter,
          limit,
        },
      }),
      [200],
    );
    return result.body;
  },
);

export const memoryInjectionPreview$ = computed(
  async (get): Promise<MemoryInjectionPreviewResponse | null> => {
    get(internalMemoryInjectionReload$);
    const prompt = get(submittedMemoryInjectionPrompt$).trim();
    if (prompt.length === 0) {
      return null;
    }

    const client = get(zeroClient$)(zeroMemoryContract);
    const result = await accept(
      client.injectionPreview({
        body: { prompt },
      }),
      [200],
    );
    return result.body;
  },
);

export const slackMemoryStatus$ = computed(
  async (get): Promise<SlackMemoryStatusResponse> => {
    get(internalSlackMemoryStatusReload$);
    const client = get(zeroClient$)(zeroMemoryContract);
    const result = await accept(client.slackStatus(), [200]);
    return result.body;
  },
);

export const startSlackMemoryBackfill$ = command(
  async (
    { get, set },
    options: SlackMemoryBackfillRequest,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(zeroMemoryContract);
    await accept(
      client.slackBackfill({ body: options, fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    toast.success("Slack memory backfill started");
    set(reloadSlackMemoryStatus$);
    set(reloadMemorySources$);
  },
);

export const stopSlackMemoryBackfill$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const client = get(zeroClient$)(zeroMemoryContract);
    await accept(client.slackStopBackfill({ fetchOptions: { signal } }), [200]);
    signal.throwIfAborted();
    toast.success("Slack memory backfill stopped");
    set(reloadSlackMemoryStatus$);
    set(reloadMemorySources$);
  },
);

export const gmailRelationshipStatus$ = computed(
  async (get): Promise<GmailRelationshipStatusResponse> => {
    get(internalGmailRelationshipStatusReload$);
    const client = get(zeroClient$)(zeroRelationshipsContract);
    const result = await accept(client.gmailStatus(), [200]);
    return result.body;
  },
);

export const startGmailRelationshipBackfill$ = command(
  async (
    { get, set },
    options: GmailRelationshipBackfillRequest,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(zeroRelationshipsContract);
    await accept(
      client.gmailBackfill({ body: options, fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    toast.success("Gmail relationship backfill started");
    set(reloadGmailRelationshipStatus$);
    set(reloadMemoryRelationships$);
  },
);

export const stopGmailRelationshipBackfill$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const client = get(zeroClient$)(zeroRelationshipsContract);
    await accept(client.gmailStopBackfill({ fetchOptions: { signal } }), [200]);
    signal.throwIfAborted();
    toast.success("Gmail relationship backfill stopped");
    set(reloadGmailRelationshipStatus$);
    set(reloadMemoryRelationships$);
  },
);

export const deleteStoppedGmailRelationshipBackfill$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const client = get(zeroClient$)(zeroRelationshipsContract);
    await accept(
      client.gmailDeleteStoppedBackfill({ fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    toast.success("Stopped Gmail backfill job deleted");
    set(reloadGmailRelationshipStatus$);
    set(reloadMemoryRelationships$);
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
