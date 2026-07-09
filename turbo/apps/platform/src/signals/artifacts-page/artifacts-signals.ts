import { command, computed, state } from "ccstate";
import {
  artifactsContract,
  type ArtifactItem,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  artifactMatchesCategory,
  type ArtifactCategory,
} from "./artifact-category.ts";
import {
  artifactSearchText,
  normalizedSearchTokens,
} from "./artifact-search.ts";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { clerk$ } from "../auth.ts";
import { openChatIdb } from "../external/chat-idb-store.ts";
import { createArtifactItemCacheStores } from "../external/idb-artifact-item-store.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { onRejection } from "../utils.ts";

// Page size for the keyset-paginated fetch. The frontend follows `nextCursor`
// until the whole set is loaded, so this only bounds per-request payload size,
// not the total number of artifacts fetched.
const ARTIFACTS_PAGE_SIZE = 2000;
// Backstop against an unbounded fetch loop (e.g. a server that never returns a
// null cursor). Sits far above any realistic per-org artifact count.
const ARTIFACTS_MAX_PAGES = 100;
// Read the whole locally-cached set back for the cache-first paint.
const ARTIFACTS_CACHE_READ_LIMIT = ARTIFACTS_PAGE_SIZE * ARTIFACTS_MAX_PAGES;

// Number of cards the grid reveals per window step. The rendered window grows by
// this amount on each "load more", keeping the DOM bounded for large sets.
const ARTIFACT_WINDOW_STEP = 60;

const internalArtifactsSearch$ = state("");
const internalArtifactsAgentId$ = state<string | null>(null);
const internalArtifactsCategory$ = state<ArtifactCategory | null>(null);
const internalArtifactsFavoritesOnly$ = state(false);
const internalArtifactFavoriteOverrides$ = state<
  Readonly<Record<string, boolean>>
>({});
const internalArtifactsReload$ = state(0);
const internalArtifactsWindow$ = state(ARTIFACT_WINDOW_STEP);

interface ArtifactsPageData {
  readonly artifacts: readonly ArtifactItem[];
}

function artifactItemCacheStores(userId: string, orgId: string) {
  return createArtifactItemCacheStores(() => {
    return openChatIdb(userId, orgId);
  });
}

export const artifactsSearch$ = computed((get) => {
  return get(internalArtifactsSearch$);
});

export const selectedArtifactsAgentId$ = computed((get) => {
  return get(internalArtifactsAgentId$);
});

export const selectedArtifactsCategory$ = computed((get) => {
  return get(internalArtifactsCategory$);
});

export const artifactsFavoritesOnly$ = computed((get) => {
  return get(internalArtifactsFavoritesOnly$);
});

// How many artifacts the grid currently reveals. Grown by the view's "load
// more" control and reset to the first window whenever a filter changes.
export const artifactsWindow$ = computed((get) => {
  return get(internalArtifactsWindow$);
});

export const growArtifactsWindow$ = command(({ set }) => {
  set(internalArtifactsWindow$, (count) => {
    return count + ARTIFACT_WINDOW_STEP;
  });
});

export const setArtifactsSearch$ = command(({ set }, search: string) => {
  set(internalArtifactsSearch$, search);
  set(internalArtifactsWindow$, ARTIFACT_WINDOW_STEP);
});

export const setSelectedArtifactsAgentId$ = command(
  ({ set }, agentId: string | null) => {
    set(internalArtifactsAgentId$, agentId);
    set(internalArtifactsWindow$, ARTIFACT_WINDOW_STEP);
  },
);

export const setSelectedArtifactsCategory$ = command(
  ({ set }, artifactCategory: ArtifactCategory | null) => {
    set(internalArtifactsCategory$, artifactCategory);
    set(internalArtifactsWindow$, ARTIFACT_WINDOW_STEP);
  },
);

export const setArtifactsFavoritesOnly$ = command(
  ({ set }, favoritesOnly: boolean) => {
    set(internalArtifactsFavoritesOnly$, favoritesOnly);
    set(internalArtifactsWindow$, ARTIFACT_WINDOW_STEP);
  },
);

export const resetArtifactsFilters$ = command(({ set }) => {
  set(internalArtifactsSearch$, "");
  set(internalArtifactsAgentId$, null);
  set(internalArtifactsCategory$, null);
  set(internalArtifactsFavoritesOnly$, false);
  set(internalArtifactsWindow$, ARTIFACT_WINDOW_STEP);
});

export const reloadArtifacts$ = command(({ set }) => {
  set(internalArtifactsReload$, (version) => {
    return version + 1;
  });
});

// Remote source: keyset-paginate through every artifact for the org (following
// `nextCursor` until the set is exhausted), replace the IndexedDB cache with the
// full set, and return it. Errors propagate to the loadable so the view can fall
// back to the cache. Reacts only to the reload counter, never to the filters, so
// filtering never triggers a re-fetch.
export const remoteArtifacts$ = computed(
  async (get): Promise<ArtifactsPageData> => {
    get(internalArtifactsReload$);
    const clerk = await get(clerk$);
    const userId = clerk.user?.id;
    const orgId = clerk.organization?.id;
    if (!userId || !orgId) {
      return { artifacts: [] };
    }
    const client = get(zeroClient$)(artifactsContract);
    const artifacts: ArtifactItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < ARTIFACTS_MAX_PAGES; page += 1) {
      const result = await accept(
        client.list({ query: { limit: ARTIFACTS_PAGE_SIZE, cursor } }),
        [200],
        { toast: false },
      );
      artifacts.push(...result.body.artifacts);
      if (!result.body.nextCursor) {
        break;
      }
      cursor = result.body.nextCursor;
    }
    await artifactItemCacheStores(userId, orgId).writeStore.replaceItems(
      artifacts,
    );
    return { artifacts };
  },
);

// Cache-first paint: the last-known artifact set from IndexedDB. Never throws
// (reads degrade to an empty list), so it is always a safe fallback.
export const cachedArtifacts$ = computed(
  async (get): Promise<ArtifactsPageData> => {
    const clerk = await get(clerk$);
    const userId = clerk.user?.id;
    const orgId = clerk.organization?.id;
    if (!userId || !orgId) {
      return { artifacts: [] };
    }
    const artifacts = await artifactItemCacheStores(
      userId,
      orgId,
    ).readStore.readRecent({ limit: ARTIFACTS_CACHE_READ_LIMIT });
    return { artifacts };
  },
);

function applyArtifactFavoriteOverride(
  item: ArtifactItem,
  overrides: Readonly<Record<string, boolean>>,
): ArtifactItem {
  if (!(item.url in overrides)) {
    return item;
  }
  return { ...item, isFavorited: overrides[item.url] ?? false };
}

export function applyArtifactFavoriteOverrides(
  artifacts: readonly ArtifactItem[],
  overrides: Readonly<Record<string, boolean>>,
): ArtifactItem[] {
  return artifacts.map((artifact) => {
    return applyArtifactFavoriteOverride(artifact, overrides);
  });
}

export const artifactFavoriteOverrides$ = computed((get) => {
  return get(internalArtifactFavoriteOverrides$);
});

// Applies the search / agent / category filters in memory over the active set,
// so switching filters is instant and never re-fetches or truncates.
export function filterArtifacts(
  artifacts: readonly ArtifactItem[],
  filters: {
    readonly search: string;
    readonly agentId: string | null;
    readonly category: ArtifactCategory | null;
    readonly favoritesOnly: boolean;
  },
): ArtifactItem[] {
  const searchTokens = normalizedSearchTokens(filters.search);
  const filtered = artifacts.filter((item) => {
    if (filters.agentId && item.agentId !== filters.agentId) {
      return false;
    }
    if (!artifactMatchesCategory(item, filters.category)) {
      return false;
    }
    if (filters.favoritesOnly && item.isFavorited !== true) {
      return false;
    }
    if (searchTokens.length === 0) {
      return true;
    }
    const text = artifactSearchText(item);
    return searchTokens.every((token) => {
      return text.includes(token);
    });
  });
  return filtered;
}

export const toggleArtifactFavorite$ = command(
  async ({ get, set }, item: ArtifactItem, signal: AbortSignal) => {
    const currentIsFavorited = item.isFavorited === true;
    const nextIsFavorited = !currentIsFavorited;
    set(internalArtifactFavoriteOverrides$, (overrides) => {
      return { ...overrides, [item.url]: nextIsFavorited };
    });

    const client = get(zeroClient$)(artifactsContract);
    const request = nextIsFavorited
      ? accept(
          client.favorite({
            body: { artifactUrl: item.url },
            fetchOptions: { signal },
          }),
          [204],
        )
      : accept(
          client.unfavorite({
            body: { artifactUrl: item.url },
            fetchOptions: { signal },
          }),
          [204],
        );
    await onRejection(request, () => {
      if (!signal.aborted) {
        set(internalArtifactFavoriteOverrides$, (overrides) => {
          return { ...overrides, [item.url]: currentIsFavorited };
        });
      }
    });
    signal.throwIfAborted();

    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const userId = clerk.user?.id;
    const orgId = clerk.organization?.id;
    if (userId && orgId) {
      await artifactItemCacheStores(userId, orgId).writeStore.upsertItems([
        { ...item, isFavorited: nextIsFavorited },
      ]);
    }
    signal.throwIfAborted();
    set(reloadArtifacts$);
  },
);

export const navigateToArtifactThread$ = command(
  ({ set }, threadId: string) => {
    set(detachedNavigateTo$, ROUTES.chat, {
      pathParams: { threadId },
    });
  },
);
