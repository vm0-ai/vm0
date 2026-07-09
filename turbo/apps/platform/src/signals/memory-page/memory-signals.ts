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
  type GithubMemoryBackfillRequest,
  type GithubMemoryConfigureRequest,
  type GithubMemoryContributorsResponse,
  type GithubMemoryRepositoriesResponse,
  type GithubMemoryStatusResponse,
  type NotionMemoryBackfillRequest,
  type NotionMemoryStatusResponse,
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

type GithubMemoryRepositoryResource =
  GithubMemoryRepositoriesResponse["repositories"][number];

export interface GithubMemoryRepositoryDraft {
  readonly id: number | null;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string | null;
  readonly selected: boolean;
  readonly wasSelected: boolean;
  readonly includeIssues: boolean;
  readonly includePullRequests: boolean;
  readonly includeComments: boolean;
  readonly trustedText: string;
}

export type MemoryTab =
  | "updates"
  | "injection"
  | "recall"
  | "relationships"
  | "sources"
  | "raw";

export const MEMORY_ACTIVITY_RECENT_LIMIT = 7;
const GITHUB_MEMORY_REPOSITORIES_PAGE_SIZE = 50;

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

function defaultGithubMemoryBackfillRequest(): GithubMemoryBackfillRequest {
  return { days: 180 };
}

function githubTrustedTextFromContributors(
  contributors: GithubMemoryRepositoryResource["trustedContributors"],
): string {
  return contributors
    .map((contributor) => {
      return (
        contributor.login ?? contributor.githubUserId ?? contributor.email ?? ""
      );
    })
    .filter((value) => {
      return value.length > 0;
    })
    .join(", ");
}

function githubRepositoryDraftFromResource(
  repository: GithubMemoryRepositoryResource,
): GithubMemoryRepositoryDraft {
  return {
    id: repository.id,
    name: repository.name,
    fullName: repository.fullName,
    defaultBranch: repository.defaultBranch,
    selected: repository.selected,
    wasSelected: repository.selected,
    includeIssues: repository.includeIssues,
    includePullRequests: repository.includePullRequests,
    includeComments: repository.includeComments,
    trustedText: githubTrustedTextFromContributors(
      repository.trustedContributors,
    ),
  };
}

function mergeGithubRepositoryDrafts(
  current: readonly GithubMemoryRepositoryDraft[],
  incoming: readonly GithubMemoryRepositoryResource[],
): readonly GithubMemoryRepositoryDraft[] {
  const currentKeys = new Set(
    current.map((draft) => {
      return draft.fullName.toLowerCase();
    }),
  );
  const additions = incoming
    .filter((repository) => {
      return !currentKeys.has(repository.fullName.toLowerCase());
    })
    .map(githubRepositoryDraftFromResource);
  return [...current, ...additions];
}

function defaultNotionMemoryBackfillRequest(): NotionMemoryBackfillRequest {
  return { days: 180, documentLimit: 1000 };
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
const internalGithubMemoryStatusReload$ = state(0);
const internalGithubMemoryRepositoriesReload$ = state(0);
const internalGithubMemoryConfigDialogOpen$ = state(false);
const internalGithubMemoryRepositoryDrafts$ = state<
  readonly GithubMemoryRepositoryDraft[]
>([]);
const internalGithubMemoryRepositoryDraftPage$ = state(1);
const internalGithubMemoryRepositoryDraftHasMore$ = state(false);
const internalGithubMemoryContributorRepository$ = state<string | null>(null);
const internalGithubMemoryContributorsReload$ = state(0);
const internalGithubMemoryBackfillDialogOpen$ = state(false);
const internalGithubMemoryBackfillRequest$ = state<GithubMemoryBackfillRequest>(
  defaultGithubMemoryBackfillRequest(),
);
const internalNotionMemoryStatusReload$ = state(0);
const internalNotionMemoryBackfillDialogOpen$ = state(false);
const internalNotionMemoryBackfillRequest$ = state<NotionMemoryBackfillRequest>(
  defaultNotionMemoryBackfillRequest(),
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

export const reloadGithubMemoryStatus$ = command(({ set }) => {
  set(internalGithubMemoryStatusReload$, (current) => {
    return current + 1;
  });
});

export const reloadGithubMemoryRepositories$ = command(({ set }) => {
  set(internalGithubMemoryRepositoriesReload$, (current) => {
    return current + 1;
  });
});

export const reloadNotionMemoryStatus$ = command(({ set }) => {
  set(internalNotionMemoryStatusReload$, (current) => {
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

export const githubMemoryConfigDialogOpen$ = computed((get) => {
  return get(internalGithubMemoryConfigDialogOpen$);
});

export const githubMemoryRepositoryDrafts$ = computed((get) => {
  return get(internalGithubMemoryRepositoryDrafts$);
});

export const setGithubMemoryConfigDialogOpen$ = command(
  (
    { set },
    args: {
      readonly open: boolean;
      readonly repositories?: readonly GithubMemoryRepositoryResource[];
      readonly pagination?: GithubMemoryRepositoriesResponse["pagination"];
    },
  ) => {
    set(internalGithubMemoryConfigDialogOpen$, args.open);
    if (args.open && args.repositories) {
      set(
        internalGithubMemoryRepositoryDrafts$,
        args.repositories.map(githubRepositoryDraftFromResource),
      );
      set(internalGithubMemoryRepositoryDraftPage$, args.pagination?.page ?? 1);
      set(
        internalGithubMemoryRepositoryDraftHasMore$,
        args.pagination?.hasMore ?? false,
      );
      set(internalGithubMemoryContributorRepository$, null);
    }
    if (!args.open) {
      set(internalGithubMemoryContributorRepository$, null);
    }
  },
);

export const githubMemoryRepositoryDraftHasMore$ = computed((get) => {
  return get(internalGithubMemoryRepositoryDraftHasMore$);
});

export const updateGithubMemoryRepositoryDraft$ = command(
  (
    { set },
    args: {
      readonly index: number;
      readonly patch: Partial<GithubMemoryRepositoryDraft>;
    },
  ) => {
    set(internalGithubMemoryRepositoryDrafts$, (current) => {
      return current.map((draft, index) => {
        return index === args.index ? { ...draft, ...args.patch } : draft;
      });
    });
  },
);

export const githubMemoryContributorRepository$ = computed((get) => {
  return get(internalGithubMemoryContributorRepository$);
});

export const setGithubMemoryContributorRepository$ = command(
  ({ set }, repository: string | null) => {
    set(internalGithubMemoryContributorRepository$, repository);
    if (repository !== null) {
      set(internalGithubMemoryContributorsReload$, (current) => {
        return current + 1;
      });
    }
  },
);

export const githubMemoryContributors$ = computed(
  async (get): Promise<GithubMemoryContributorsResponse | null> => {
    get(internalGithubMemoryContributorsReload$);
    const repository = get(internalGithubMemoryContributorRepository$);
    if (repository === null) {
      return null;
    }

    const client = get(zeroClient$)(zeroMemoryContract);
    const result = await accept(
      client.githubContributors({
        query: { repository, page: 1, limit: 100 },
      }),
      [200],
    );
    return result.body;
  },
);

export const loadMoreGithubMemoryRepositories$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const nextPage = get(internalGithubMemoryRepositoryDraftPage$) + 1;
    const client = get(zeroClient$)(zeroMemoryContract);
    const result = await accept(
      client.githubRepositories({
        query: {
          page: nextPage,
          limit: GITHUB_MEMORY_REPOSITORIES_PAGE_SIZE,
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalGithubMemoryRepositoryDrafts$, (current) => {
      return mergeGithubRepositoryDrafts(current, result.body.repositories);
    });
    set(internalGithubMemoryRepositoryDraftPage$, result.body.pagination.page);
    set(
      internalGithubMemoryRepositoryDraftHasMore$,
      result.body.pagination.hasMore,
    );
  },
);

export const githubMemoryBackfillDialogOpen$ = computed((get) => {
  return get(internalGithubMemoryBackfillDialogOpen$);
});

export const setGithubMemoryBackfillDialogOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalGithubMemoryBackfillDialogOpen$, open);
    if (open) {
      set(
        internalGithubMemoryBackfillRequest$,
        defaultGithubMemoryBackfillRequest(),
      );
    }
  },
);

export const githubMemoryBackfillRequest$ = computed((get) => {
  return get(internalGithubMemoryBackfillRequest$);
});

export const updateGithubMemoryBackfillRequest$ = command(
  ({ set }, patch: Partial<GithubMemoryBackfillRequest>) => {
    set(internalGithubMemoryBackfillRequest$, (current) => {
      return { ...current, ...patch };
    });
  },
);

export const notionMemoryBackfillDialogOpen$ = computed((get) => {
  return get(internalNotionMemoryBackfillDialogOpen$);
});

export const setNotionMemoryBackfillDialogOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalNotionMemoryBackfillDialogOpen$, open);
    if (open) {
      set(
        internalNotionMemoryBackfillRequest$,
        defaultNotionMemoryBackfillRequest(),
      );
    }
  },
);

export const notionMemoryBackfillRequest$ = computed((get) => {
  return get(internalNotionMemoryBackfillRequest$);
});

export const updateNotionMemoryBackfillRequest$ = command(
  ({ set }, patch: Partial<NotionMemoryBackfillRequest>) => {
    set(internalNotionMemoryBackfillRequest$, (current) => {
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

export const githubMemoryStatus$ = computed(
  async (get): Promise<GithubMemoryStatusResponse> => {
    get(internalGithubMemoryStatusReload$);
    const client = get(zeroClient$)(zeroMemoryContract);
    const result = await accept(client.githubStatus(), [200]);
    return result.body;
  },
);

export const githubMemoryRepositories$ = computed(
  async (get): Promise<GithubMemoryRepositoriesResponse> => {
    get(internalGithubMemoryRepositoriesReload$);
    const client = get(zeroClient$)(zeroMemoryContract);
    const result = await accept(
      client.githubRepositories({
        query: { page: 1, limit: GITHUB_MEMORY_REPOSITORIES_PAGE_SIZE },
      }),
      [200],
    );
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

export const configureGithubMemory$ = command(
  async (
    { get, set },
    options: GithubMemoryConfigureRequest,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(zeroMemoryContract);
    await accept(
      client.githubConfigure({ body: options, fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    toast.success("GitHub memory configuration saved");
    set(reloadGithubMemoryStatus$);
    set(reloadGithubMemoryRepositories$);
  },
);

export const startGithubMemoryBackfill$ = command(
  async (
    { get, set },
    options: GithubMemoryBackfillRequest,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(zeroMemoryContract);
    await accept(
      client.githubBackfill({ body: options, fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    toast.success("GitHub memory backfill started");
    set(reloadGithubMemoryStatus$);
    set(reloadMemorySources$);
  },
);

export const stopGithubMemoryBackfill$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const client = get(zeroClient$)(zeroMemoryContract);
    await accept(
      client.githubStopBackfill({ fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    toast.success("GitHub memory backfill stopped");
    set(reloadGithubMemoryStatus$);
    set(reloadMemorySources$);
  },
);

export const notionMemoryStatus$ = computed(
  async (get): Promise<NotionMemoryStatusResponse> => {
    get(internalNotionMemoryStatusReload$);
    const client = get(zeroClient$)(zeroMemoryContract);
    const result = await accept(client.notionStatus(), [200]);
    return result.body;
  },
);

export const startNotionMemoryBackfill$ = command(
  async (
    { get, set },
    options: NotionMemoryBackfillRequest,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(zeroMemoryContract);
    await accept(
      client.notionBackfill({ body: options, fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    toast.success("Notion memory backfill started");
    set(reloadNotionMemoryStatus$);
    set(reloadMemorySources$);
  },
);

export const stopNotionMemoryBackfill$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const client = get(zeroClient$)(zeroMemoryContract);
    await accept(
      client.notionStopBackfill({ fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    toast.success("Notion memory backfill stopped");
    set(reloadNotionMemoryStatus$);
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
