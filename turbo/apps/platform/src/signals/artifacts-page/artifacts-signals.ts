import { command, computed, state } from "ccstate";
import type { IDBPDatabase } from "idb";
import { delay } from "signal-timers";
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
import { onRef, resetSignal, settle } from "../utils.ts";
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
// Number of cards the grid makes available per automatic loading step. Row
// virtualization keeps the mounted DOM bounded independently of this window.
const ARTIFACT_WINDOW_STEP = 60;
// The background merge still needs the complete cached snapshot, but first
// paint only needs the first visible window.
const ARTIFACTS_FULL_CACHE_READ_LIMIT =
  ARTIFACTS_PAGE_SIZE * ARTIFACTS_MAX_PAGES;
const ARTIFACT_FOCUS_TARGET_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const internalArtifactsSearch$ = state("");
const internalArtifactsAgentId$ = state<string | null>(null);
const internalArtifactsCategories$ = state<readonly ArtifactCategory[]>([]);
const internalArtifactsReload$ = state(0);
const internalArtifactsWindow$ = state(ARTIFACT_WINDOW_STEP);
const internalArtifactsScrollViewport$ = state<HTMLElement | null>(null);
const internalArtifactsGridElement$ = state<HTMLElement | null>(null);
const internalArtifactsGridWidth$ = state(0);
const internalArtifactsPendingFocusIndex$ = state<number | null>(null);
const resetArtifactsSyncSignal$ = resetSignal();

interface ArtifactsPageData {
  readonly artifacts: readonly ArtifactItem[];
}

export interface RemoteArtifactsData extends ArtifactsPageData {
  readonly mergeCachedArtifacts: boolean;
}

interface RemoteArtifactsProgress extends RemoteArtifactsData {
  readonly reload: number;
}

const internalRemoteArtifactsProgress$ = state<RemoteArtifactsProgress | null>(
  null,
);

interface ArtifactsScrollMetrics {
  readonly clientHeight: number;
  readonly scrollTop: number;
}

const internalArtifactsScrollMetrics$ = state<ArtifactsScrollMetrics>({
  clientHeight: 0,
  scrollTop: 0,
});

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

export const selectedArtifactsCategories$ = computed((get) => {
  return get(internalArtifactsCategories$);
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

export const setSelectedArtifactsCategories$ = command(
  ({ set }, artifactCategories: readonly ArtifactCategory[]) => {
    set(internalArtifactsCategories$, artifactCategories);
    set(internalArtifactsWindow$, ARTIFACT_WINDOW_STEP);
  },
);

export const clearArtifactsFacetFilters$ = command(({ set }) => {
  set(internalArtifactsAgentId$, null);
  set(internalArtifactsCategories$, []);
  set(internalArtifactsWindow$, ARTIFACT_WINDOW_STEP);
});

export const resetArtifactsFilters$ = command(({ set }) => {
  set(internalArtifactsSearch$, "");
  set(internalArtifactsAgentId$, null);
  set(internalArtifactsCategories$, []);
  set(internalArtifactsWindow$, ARTIFACT_WINDOW_STEP);
});

export const reloadArtifacts$ = command(({ set }) => {
  set(internalRemoteArtifactsProgress$, null);
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

function compareArtifactWinner(
  left: ArtifactItem,
  right: ArtifactItem,
): number {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt.localeCompare(right.updatedAt);
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt.localeCompare(right.createdAt);
  }
  return left.artifactItemId.localeCompare(right.artifactItemId);
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
  const byUrl = new Map<string, ArtifactItem>();
  for (const item of byId.values()) {
    if (hostedRunIds.has(item.runId) && !artifactIsHosted(item)) {
      continue;
    }
    const current = byUrl.get(item.url);
    if (!current || compareArtifactWinner(item, current) > 0) {
      byUrl.set(item.url, item);
    }
  }

  return Array.from(byUrl.values()).sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return right.createdAt.localeCompare(left.createdAt);
    }
    return right.artifactItemId.localeCompare(left.artifactItemId);
  });
}

interface InitialRemoteArtifactsPage extends RemoteArtifactsData {
  readonly nextCursor: string | null;
  readonly reload: number;
  readonly syncUntil: string | undefined;
  readonly updatedAfter: string | undefined;
}

interface FetchRemainingArtifactPagesInput {
  readonly initialArtifacts: readonly ArtifactItem[];
  readonly initialCursor: string | undefined;
  readonly initialSyncUntil: string | undefined;
  readonly mergeCachedArtifacts: boolean;
  readonly reload: number;
  readonly updatedAfter: string | undefined;
}

interface RemoteArtifactsSnapshot {
  readonly artifacts: ArtifactItem[];
  readonly syncUntil: string | undefined;
}

// The first remote page resolves independently so the view can render it while
// later cursor pages continue loading.
const initialRemoteArtifactsPage$ = computed(
  async (get): Promise<InitialRemoteArtifactsPage> => {
    const reload = get(internalArtifactsReload$);
    const dbPromise = get(chatIdb$);
    const client = get(zeroClient$)(artifactsContract);
    const stores = artifactItemCacheStores(dbPromise);
    const [cachedHead, lastSyncedAt] = await Promise.all([
      // This best-effort single-row read only preserves the rollout fallback
      // for caches created before sync timestamps existed. The cache-first
      // display uses the strict bounded read below.
      stores.readStore.readRecentBestEffort({ limit: 1 }),
      stores.readStore.readLastSyncedAt(),
    ]);
    const updatedAfter =
      cachedHead.length === 0
        ? undefined
        : (lastSyncedAt ?? cachedHead[0]?.createdAt);
    const result = await accept(
      client.list({
        query: {
          limit: ARTIFACTS_PAGE_SIZE,
          updatedAfter,
        },
      }),
      [200],
    );
    const syncUntil = result.body.syncUntil;
    return {
      artifacts: mergeArtifactItems(
        [],
        result.body.artifacts.map((item) => {
          return artifactItemSchema.parse(item);
        }),
      ),
      mergeCachedArtifacts: Boolean(updatedAfter && syncUntil),
      nextCursor: result.body.nextCursor,
      reload,
      syncUntil,
      updatedAfter,
    };
  },
);

// Remote source: publish the first page immediately, then adopt each cumulative
// page produced by syncArtifacts$.
export const remoteArtifacts$ = computed(
  async (get): Promise<RemoteArtifactsData> => {
    const progress = get(internalRemoteArtifactsProgress$);
    const initial = await get(initialRemoteArtifactsPage$);
    const current = progress?.reload === initial.reload ? progress : initial;
    return {
      artifacts: current.artifacts,
      mergeCachedArtifacts: current.mergeCachedArtifacts,
    };
  },
);

const fetchRemainingArtifactPages$ = command(
  async (
    { get, set },
    input: FetchRemainingArtifactPagesInput,
    signal: AbortSignal,
  ): Promise<RemoteArtifactsSnapshot | null> => {
    const client = get(zeroClient$)(artifactsContract);
    let artifacts = [...input.initialArtifacts];
    let cursor = input.initialCursor;
    let syncUntil = input.initialSyncUntil;
    set(internalRemoteArtifactsProgress$, {
      artifacts,
      mergeCachedArtifacts: input.mergeCachedArtifacts,
      reload: input.reload,
    });

    for (let page = 1; cursor && page < ARTIFACTS_MAX_PAGES; page += 1) {
      const result = await accept(
        client.list({
          query: {
            limit: ARTIFACTS_PAGE_SIZE,
            cursor,
            updatedAfter: input.updatedAfter,
          },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      syncUntil ??= result.body.syncUntil;
      artifacts = mergeArtifactItems(
        artifacts,
        result.body.artifacts.map((item) => {
          return artifactItemSchema.parse(item);
        }),
      );
      if (get(internalArtifactsReload$) !== input.reload) {
        return null;
      }
      set(internalRemoteArtifactsProgress$, {
        artifacts,
        mergeCachedArtifacts: input.mergeCachedArtifacts,
        reload: input.reload,
      });
      cursor = result.body.nextCursor ?? undefined;
    }

    return { artifacts, syncUntil };
  },
);

// Continue the remote cursor walk after first-page paint. Cache persistence is
// deliberately last so it never gates data already published to the view.
export const syncArtifacts$ = command(
  async ({ get, set }, parentSignal: AbortSignal) => {
    const signal = set(resetArtifactsSyncSignal$, parentSignal);
    const initial = await get(initialRemoteArtifactsPage$);
    signal.throwIfAborted();
    if (get(internalArtifactsReload$) !== initial.reload) {
      return;
    }

    const incrementalSnapshot = await set(
      fetchRemainingArtifactPages$,
      {
        initialArtifacts: initial.artifacts,
        initialCursor: initial.nextCursor ?? undefined,
        initialSyncUntil: initial.syncUntil,
        mergeCachedArtifacts: initial.mergeCachedArtifacts,
        reload: initial.reload,
        updatedAfter: initial.updatedAfter,
      },
      signal,
    );
    if (!incrementalSnapshot) {
      return;
    }
    let { artifacts, syncUntil } = incrementalSnapshot;

    signal.throwIfAborted();
    if (get(internalArtifactsReload$) !== initial.reload) {
      return;
    }

    const stores = artifactItemCacheStores(get(chatIdb$));
    if (initial.mergeCachedArtifacts) {
      const cachedArtifactsResult = await settle(
        stores.readStore.readRecent(
          { limit: ARTIFACTS_FULL_CACHE_READ_LIMIT },
          signal,
        ),
        signal,
      );
      if (get(internalArtifactsReload$) !== initial.reload) {
        return;
      }
      if (cachedArtifactsResult.ok) {
        artifacts = mergeArtifactItems(cachedArtifactsResult.value, artifacts);
      } else {
        // An incremental response is incomplete without the full local
        // snapshot. If IndexedDB cannot provide it within its strict deadline,
        // recover with an authoritative server snapshot instead of silently
        // leaving the view capped at its 60-item first-paint window.
        const result = await accept(
          get(zeroClient$)(artifactsContract).list({
            query: { limit: ARTIFACTS_PAGE_SIZE },
            fetchOptions: { signal },
          }),
          [200],
        );
        signal.throwIfAborted();
        if (get(internalArtifactsReload$) !== initial.reload) {
          return;
        }
        const fullSnapshot = await set(
          fetchRemainingArtifactPages$,
          {
            initialArtifacts: mergeArtifactItems(
              [],
              result.body.artifacts.map((item) => {
                return artifactItemSchema.parse(item);
              }),
            ),
            initialCursor: result.body.nextCursor ?? undefined,
            initialSyncUntil: result.body.syncUntil,
            mergeCachedArtifacts: false,
            reload: initial.reload,
            updatedAfter: undefined,
          },
          signal,
        );
        if (!fullSnapshot) {
          return;
        }
        ({ artifacts, syncUntil } = fullSnapshot);
      }
    }
    set(internalRemoteArtifactsProgress$, {
      artifacts,
      mergeCachedArtifacts: false,
      reload: initial.reload,
    });

    // Yield a browser task after publishing the complete snapshot so React can
    // paint it before a large clear-and-replace transaction starts.
    await delay(0, { signal });
    signal.throwIfAborted();
    if (get(internalArtifactsReload$) !== initial.reload) {
      return;
    }
    const cacheUpdated = await stores.writeStore.replaceItems(
      artifacts,
      signal,
    );
    signal.throwIfAborted();
    if (get(internalArtifactsReload$) !== initial.reload) {
      return;
    }
    if (cacheUpdated && syncUntil) {
      await stores.writeStore.setLastSyncedAt(syncUntil, signal);
    }
  },
);

export function mergeArtifactSources(
  cachedArtifacts: readonly ArtifactItem[],
  remote: RemoteArtifactsData | null,
): readonly ArtifactItem[] {
  if (!remote) {
    return cachedArtifacts;
  }
  return remote.mergeCachedArtifacts
    ? mergeArtifactItems(cachedArtifacts, remote.artifacts)
    : remote.artifacts;
}

// Cache-first paint reads only the first visible window. Unlike the background
// full-snapshot read, failures remain distinguishable from a genuinely empty
// cache through the loadable state.
export const cachedArtifacts$ = computed(
  async (get): Promise<ArtifactsPageData> => {
    get(internalArtifactsReload$);
    const dbPromise = get(chatIdb$);
    const artifacts = await artifactItemCacheStores(
      dbPromise,
    ).readStore.readRecent({ limit: ARTIFACT_WINDOW_STEP });
    return { artifacts };
  },
);

// Applies the search / agent / category filters in memory over the active set,
// so switching filters is instant and never re-fetches or truncates.
export function filterArtifacts(
  artifacts: readonly ArtifactItem[],
  filters: {
    readonly search: string;
    readonly agentId: string | null;
    readonly categories: readonly ArtifactCategory[];
  },
): ArtifactItem[] {
  const searchTokens = normalizedSearchTokens(filters.search);
  const filtered = artifacts.filter((item) => {
    if (filters.agentId && item.agentId !== filters.agentId) {
      return false;
    }
    if (
      filters.categories.length > 0 &&
      !filters.categories.some((category) => {
        return artifactMatchesCategory(item, category);
      })
    ) {
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
