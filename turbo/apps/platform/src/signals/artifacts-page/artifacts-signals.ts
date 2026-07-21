import { command, computed, state } from "ccstate";
import type { IDBPDatabase } from "idb";
import {
  artifactItemSchema,
  artifactsContract,
  type PersistedAttachment,
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
import { chatIdb$ } from "../external/chat-idb-store.ts";
import { createArtifactItemCacheStores } from "../external/idb-artifact-item-store.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { onRef, onRejection } from "../utils.ts";
import {
  ensureAgentDraft$,
  loadAgentDraft$,
} from "../zero-page/agent-draft.ts";

// Page size for the keyset-paginated fetch. The frontend follows `nextCursor`
// until the whole set is loaded, so this only bounds per-request payload size,
// not the total number of artifacts fetched.
const ARTIFACTS_PAGE_SIZE = 2000;
// Backstop against an unbounded fetch loop (e.g. a server that never returns a
// null cursor). Sits far above any realistic per-org artifact count.
const ARTIFACTS_MAX_PAGES = 100;
// Read the whole locally-cached set back for the cache-first paint.
const ARTIFACTS_CACHE_READ_LIMIT = ARTIFACTS_PAGE_SIZE * ARTIFACTS_MAX_PAGES;

// Number of cards the grid makes available per automatic loading step. Row
// virtualization keeps the mounted DOM bounded independently of this window.
const ARTIFACT_WINDOW_STEP = 60;
const ARTIFACT_FOCUS_TARGET_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const internalArtifactsSearch$ = state("");
const internalArtifactsAgentId$ = state<string | null>(null);
const internalArtifactsCategory$ = state<ArtifactCategory | null>(null);
const internalArtifactsFavoritesOnly$ = state(false);
const internalArtifactFavoriteOverrides$ = state<
  Readonly<Record<string, boolean>>
>({});
const internalArtifactFavoritesReload$ = state(0);
const internalArtifactsReload$ = state(0);
const internalArtifactsWindow$ = state(ARTIFACT_WINDOW_STEP);
const internalArtifactsScrollViewport$ = state<HTMLElement | null>(null);
const internalArtifactsGridElement$ = state<HTMLElement | null>(null);
const internalArtifactsGridWidth$ = state(0);
const internalArtifactsPendingFocusIndex$ = state<number | null>(null);

interface ArtifactsScrollMetrics {
  readonly clientHeight: number;
  readonly scrollTop: number;
}

const internalArtifactsScrollMetrics$ = state<ArtifactsScrollMetrics>({
  clientHeight: 0,
  scrollTop: 0,
});

interface ArtifactsPageData {
  readonly artifacts: readonly ArtifactItem[];
}

function artifactItemCacheStores(dbPromise: Promise<IDBPDatabase>) {
  return createArtifactItemCacheStores(() => {
    return dbPromise;
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

// How many artifacts the grid currently makes available. Grown automatically
// near the scroll boundary and reset to the first window when filters change.
export const artifactsWindow$ = computed((get) => {
  return get(internalArtifactsWindow$);
});

export const growArtifactsWindow$ = command(({ set }) => {
  set(internalArtifactsWindow$, (count) => {
    return count + ARTIFACT_WINDOW_STEP;
  });
});

export const requestArtifactsKeyboardFocus$ = command(
  ({ set }, index: number) => {
    set(internalArtifactsPendingFocusIndex$, index);
  },
);

export const artifactsScrollViewport$ = computed((get) => {
  return get(internalArtifactsScrollViewport$);
});

export const artifactsScrollMetrics$ = computed((get) => {
  return get(internalArtifactsScrollMetrics$);
});

export const artifactsGridElement$ = computed((get) => {
  return get(internalArtifactsGridElement$);
});

export const artifactsGridWidth$ = computed((get) => {
  return get(internalArtifactsGridWidth$);
});

export const syncArtifactsScrollMetrics$ = command(
  ({ set }, viewport: HTMLElement) => {
    set(internalArtifactsScrollMetrics$, {
      clientHeight: viewport.clientHeight,
      scrollTop: viewport.scrollTop,
    });
  },
);

export const setArtifactsScrollViewportRef$ = onRef(
  command(({ set }, viewport: HTMLElement, signal: AbortSignal) => {
    set(internalArtifactsScrollViewport$, viewport);
    set(syncArtifactsScrollMetrics$, viewport);

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            set(syncArtifactsScrollMetrics$, viewport);
          });
    resizeObserver?.observe(viewport);

    signal.addEventListener(
      "abort",
      () => {
        resizeObserver?.disconnect();
        set(internalArtifactsScrollViewport$, null);
        set(internalArtifactsScrollMetrics$, {
          clientHeight: 0,
          scrollTop: 0,
        });
      },
      { once: true },
    );
  }),
);

export const setArtifactsGridRef$ = onRef(
  command(({ set }, element: HTMLElement, signal: AbortSignal) => {
    const measure = () => {
      set(internalArtifactsGridElement$, element);
      set(internalArtifactsGridWidth$, element.clientWidth);
    };
    measure();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resizeObserver?.observe(element);

    signal.addEventListener(
      "abort",
      () => {
        resizeObserver?.disconnect();
        set(internalArtifactsGridElement$, null);
        set(internalArtifactsGridWidth$, 0);
      },
      { once: true },
    );
  }),
);

export function getArtifactFocusTarget(
  element: HTMLElement,
): HTMLElement | null {
  return element.matches('[tabindex="0"]')
    ? element
    : element.querySelector<HTMLElement>(ARTIFACT_FOCUS_TARGET_SELECTOR);
}

function focusArtifactElement(element: HTMLElement): boolean {
  const focusTarget = getArtifactFocusTarget(element);
  if (!focusTarget) {
    return false;
  }

  focusTarget.focus();
  return document.activeElement === focusTarget;
}

export const setArtifactCardRef$ = onRef(
  command(
    (
      { get, set },
      element: HTMLElement | SVGSVGElement,
      _signal: AbortSignal,
    ) => {
      if (!(element instanceof HTMLElement)) {
        return;
      }
      const index = Number(element.dataset.artifactIndex);
      if (!Number.isInteger(index)) {
        return;
      }
      if (get(internalArtifactsPendingFocusIndex$) !== index) {
        return;
      }
      if (focusArtifactElement(element)) {
        set(internalArtifactsPendingFocusIndex$, null);
      }
    },
  ),
);

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
  set(internalArtifactFavoriteOverrides$, {});
  set(internalArtifactFavoritesReload$, (version) => {
    return version + 1;
  });
  set(internalArtifactsWindow$, ARTIFACT_WINDOW_STEP);
});

export const reloadArtifacts$ = command(({ set }) => {
  set(internalArtifactsReload$, (version) => {
    return version + 1;
  });
});

function artifactIsHosted(item: ArtifactItem): boolean {
  return (
    item.artifactKind === "hosted-site" ||
    item.artifactKind === "presentation-html"
  );
}

function mergeArtifactItems(
  cached: readonly ArtifactItem[],
  changed: readonly ArtifactItem[],
): ArtifactItem[] {
  const byId = new Map<string, ArtifactItem>();
  for (const item of cached) {
    byId.set(item.artifactItemId, item);
  }
  for (const item of changed) {
    byId.set(item.artifactItemId, item);
  }

  const hostedRunIds = new Set(
    Array.from(byId.values())
      .filter(artifactIsHosted)
      .map((item) => {
        return item.runId;
      }),
  );
  return Array.from(byId.values())
    .filter((item) => {
      return !hostedRunIds.has(item.runId) || artifactIsHosted(item);
    })
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return right.createdAt.localeCompare(left.createdAt);
      }
      return right.artifactItemId.localeCompare(left.artifactItemId);
    });
}

// Remote source: read the last-known cache immediately, request only rows that
// changed since its synchronization timestamp, and merge those rows locally.
// A server without incremental support omits `syncUntil`; in that case its
// response is treated as the historical full snapshot for rolling-deploy
// compatibility.
export const remoteArtifacts$ = computed(
  async (get): Promise<ArtifactsPageData> => {
    get(internalArtifactsReload$);
    const dbPromise = get(chatIdb$);
    const client = get(zeroClient$)(artifactsContract);
    const stores = artifactItemCacheStores(dbPromise);
    const [cachedArtifacts, lastSyncedAt] = await Promise.all([
      stores.readStore.readRecent({ limit: ARTIFACTS_CACHE_READ_LIMIT }),
      stores.readStore.readLastSyncedAt(),
    ]);
    const updatedAfter =
      cachedArtifacts.length === 0
        ? undefined
        : (lastSyncedAt ?? cachedArtifacts[0]?.createdAt);
    const remoteArtifacts: ArtifactItem[] = [];
    let cursor: string | undefined;
    let syncUntil: string | undefined;
    for (let page = 0; page < ARTIFACTS_MAX_PAGES; page += 1) {
      const result = await accept(
        client.list({
          query: {
            limit: ARTIFACTS_PAGE_SIZE,
            cursor,
            updatedAfter,
          },
        }),
        [200],
      );
      syncUntil ??= result.body.syncUntil;
      remoteArtifacts.push(
        ...result.body.artifacts.map((item) => {
          return artifactItemSchema.parse(item);
        }),
      );
      if (!result.body.nextCursor) {
        break;
      }
      cursor = result.body.nextCursor;
    }

    const mergeBase = updatedAfter && syncUntil ? cachedArtifacts : [];
    const artifacts = mergeArtifactItems(mergeBase, remoteArtifacts);
    const cacheUpdated = await stores.writeStore.replaceItems(artifacts);
    if (cacheUpdated && syncUntil) {
      await stores.writeStore.setLastSyncedAt(syncUntil);
    }
    return { artifacts };
  },
);

// Cache-first paint: the last-known artifact set from IndexedDB. Never throws
// (reads degrade to an empty list), so it is always a safe fallback.
export const cachedArtifacts$ = computed(
  async (get): Promise<ArtifactsPageData> => {
    const dbPromise = get(chatIdb$);
    const artifacts = await artifactItemCacheStores(
      dbPromise,
    ).readStore.readRecent({ limit: ARTIFACTS_CACHE_READ_LIMIT });
    return { artifacts };
  },
);

export const remoteArtifactFavoriteUrls$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    get(internalArtifactFavoritesReload$);
    const client = get(zeroClient$)(artifactsContract);
    const result = await accept(client.listFavorites(), [200]);
    return new Set(result.body.artifactUrls);
  },
);

function applyArtifactFavoriteState(
  item: ArtifactItem,
  favoriteUrls: ReadonlySet<string>,
  overrides: Readonly<Record<string, boolean>>,
): ArtifactItem {
  return {
    ...item,
    isFavorited: overrides[item.url] ?? favoriteUrls.has(item.url),
  };
}

export function applyArtifactFavorites(
  artifacts: readonly ArtifactItem[],
  favoriteUrls: ReadonlySet<string>,
  overrides: Readonly<Record<string, boolean>>,
): ArtifactItem[] {
  return artifacts.map((artifact) => {
    return applyArtifactFavoriteState(artifact, favoriteUrls, overrides);
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
  },
);

export const navigateToArtifactThread$ = command(
  ({ set }, threadId: string) => {
    set(detachedNavigateTo$, ROUTES.chat, {
      pathParams: { threadId },
    });
  },
);

function artifactDraftAttachment(item: ArtifactItem): PersistedAttachment {
  return {
    id: item.fileId,
    url: item.url,
    filename: item.filename,
    contentType: item.contentType,
    size: item.size,
  };
}

export const startArtifactChat$ = command(
  async (
    { get, set },
    item: ArtifactItem,
    signal: AbortSignal,
  ): Promise<void> => {
    const entry = set(ensureAgentDraft$, item.agentId);
    await set(loadAgentDraft$, item.agentId, entry.draft, entry.isNew, signal);
    signal.throwIfAborted();

    if (
      item.artifactKind === "hosted-site" ||
      item.artifactKind === "presentation-html"
    ) {
      if (!get(entry.draft.input$).includes(item.url)) {
        set(
          entry.draft.appendInput$,
          `Please review ${item.filename}: ${item.url}`,
        );
      }
    } else {
      const attachments = get(entry.draft.attachments$);
      const attachmentInfos = await Promise.allSettled(
        attachments.map((attachment) => {
          return get(attachment.fileInfo$);
        }),
      );
      signal.throwIfAborted();
      const hasMatchingAttachment = attachmentInfos.some((result) => {
        return (
          result.status === "fulfilled" &&
          (result.value?.id === item.fileId || result.value?.url === item.url)
        );
      });

      if (!hasMatchingAttachment) {
        set(entry.draft.restoreAttachments$, [artifactDraftAttachment(item)]);
      }
    }

    set(detachedNavigateTo$, ROUTES.agentChat, {
      pathParams: { agentId: item.agentId },
    });
  },
);
