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
import { createIdbArtifactItemStores } from "../external/idb-artifact-item-store.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";

// Matches the server-side bulk cap (zeroArtifacts$). The cache never holds
// more than the server returns, so reading up to this bound covers the set.
const ARTIFACTS_CACHE_READ_LIMIT = 10_000;

const internalArtifactsSearch$ = state("");
const internalArtifactsAgentId$ = state<string | null>(null);
const internalArtifactsCategory$ = state<ArtifactCategory | null>(null);
const internalArtifactsReload$ = state(0);

interface ArtifactsPageData {
  readonly artifacts: readonly ArtifactItem[];
  readonly truncated: boolean;
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

export const setArtifactsSearch$ = command(({ set }, search: string) => {
  set(internalArtifactsSearch$, search);
});

export const setSelectedArtifactsAgentId$ = command(
  ({ set }, agentId: string | null) => {
    set(internalArtifactsAgentId$, agentId);
  },
);

export const setSelectedArtifactsCategory$ = command(
  ({ set }, artifactCategory: ArtifactCategory | null) => {
    set(internalArtifactsCategory$, artifactCategory);
  },
);

export const resetArtifactsFilters$ = command(({ set }) => {
  set(internalArtifactsSearch$, "");
  set(internalArtifactsAgentId$, null);
  set(internalArtifactsCategory$, null);
});

export const reloadArtifacts$ = command(({ set }) => {
  set(internalArtifactsReload$, (version) => {
    return version + 1;
  });
});

// Remote source: bulk-fetch every artifact for the org, write the full set
// through to the IndexedDB cache, and return it. Errors propagate to the
// loadable so the view can fall back to the cache. Reacts only to the reload
// counter, never to the filters, so filtering never triggers a re-fetch.
export const remoteArtifacts$ = computed(
  async (get): Promise<ArtifactsPageData> => {
    get(internalArtifactsReload$);
    const clerk = await get(clerk$);
    const userId = clerk.user?.id;
    const orgId = clerk.organization?.id;
    if (!userId || !orgId) {
      return { artifacts: [], truncated: false };
    }
    const client = get(zeroClient$)(artifactsContract);
    const result = await accept(client.list(), [200], { toast: false });
    await createIdbArtifactItemStores(userId, orgId).writeStore.replaceItems(
      result.body.artifacts,
    );
    return result.body;
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
      return { artifacts: [], truncated: false };
    }
    const artifacts = await createIdbArtifactItemStores(
      userId,
      orgId,
    ).readStore.readRecent({ limit: ARTIFACTS_CACHE_READ_LIMIT });
    return { artifacts, truncated: false };
  },
);

// Applies the search / agent / category filters in memory over the active set,
// so switching filters is instant and never re-fetches or truncates.
export function filterArtifacts(
  artifacts: readonly ArtifactItem[],
  filters: {
    readonly search: string;
    readonly agentId: string | null;
    readonly category: ArtifactCategory | null;
  },
): ArtifactItem[] {
  const searchTokens = normalizedSearchTokens(filters.search);
  return artifacts.filter((item) => {
    if (filters.agentId && item.agentId !== filters.agentId) {
      return false;
    }
    if (!artifactMatchesCategory(item, filters.category)) {
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
}

export const navigateToArtifactThread$ = command(
  ({ set }, threadId: string) => {
    set(detachedNavigateTo$, ROUTES.chat, {
      pathParams: { threadId },
    });
  },
);
