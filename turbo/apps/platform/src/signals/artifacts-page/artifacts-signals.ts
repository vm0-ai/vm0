import { command, computed, state } from "ccstate";
import type { IDBPDatabase } from "idb";
import {
  artifactItemSchema,
  artifactsContract,
  type PersistedAttachment,
  type ArtifactItem,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ArtifactCategory } from "./artifact-category.ts";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { chatIdb$ } from "../external/chat-idb-store.ts";
import { createArtifactItemCacheStores } from "../external/idb-artifact-item-store.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { onRef, settle } from "../utils.ts";
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
const ARTIFACT_FOCUS_TARGET_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const internalArtifactsSearch$ = state("");
const internalArtifactsAgentId$ = state<string | null>(null);
const internalArtifactsCategory$ = state<ArtifactCategory | null>(null);
const internalArtifactsReload$ = state(0);
const internalArtifactsWindow$ = state(ARTIFACT_WINDOW_STEP);
const internalArtifactsScrollViewport$ = state<HTMLElement | null>(null);
const internalArtifactsGridElement$ = state<HTMLElement | null>(null);
const internalArtifactsGridWidth$ = state(0);
const internalArtifactsPendingFocusIndex$ = state<number | null>(null);
const internalArtifactsPageSession$ = state<object | null>(null);

interface ArtifactsPageData {
  readonly artifacts: readonly ArtifactItem[];
}

interface ArtifactsScrollMetrics {
  readonly clientHeight: number;
  readonly scrollTop: number;
}

const internalArtifactsScrollMetrics$ = state<ArtifactsScrollMetrics>({
  clientHeight: 0,
  scrollTop: 0,
});

export const setupArtifactsPageData$ = command(
  ({ get, set }, signal: AbortSignal) => {
    const session = {};
    set(internalArtifactsPageSession$, session);
    signal.addEventListener(
      "abort",
      () => {
        if (get(internalArtifactsPageSession$) !== session) {
          return;
        }
        set(internalArtifactsPageSession$, null);
        // ccstate keeps an unmounted computed's last Promise cached. Force the
        // inactive branches now so fulfilled Promises cannot retain artifact
        // arrays after this page is gone.
        const releasedCache = get(completeCachedArtifacts$);
        const releasedSource = get(artifacts$);
        if (
          releasedCache instanceof Promise ||
          releasedSource instanceof Promise
        ) {
          throw new Error("Artifact page data release must be synchronous");
        }
      },
      { once: true },
    );
  },
);

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

export const resetArtifactsFilters$ = command(({ set }) => {
  set(internalArtifactsSearch$, "");
  set(internalArtifactsAgentId$, null);
  set(internalArtifactsCategory$, null);
  set(internalArtifactsWindow$, ARTIFACT_WINDOW_STEP);
});

export const reloadArtifacts$ = command(({ set }) => {
  set(internalArtifactsReload$, (version) => {
    return version + 1;
  });
});

const internalArtifactsReadOptions$ = computed((get) => {
  const search = get(internalArtifactsSearch$);
  const agentId = get(internalArtifactsAgentId$);
  const artifactCategory = get(internalArtifactsCategory$);

  return {
    ...(search ? { query: search } : {}),
    ...(agentId ? { agentId } : {}),
    ...(artifactCategory ? { artifactCategory } : {}),
    limit: get(internalArtifactsWindow$) + 1,
  };
});

// A completed cache can render without waiting for the remote refresh. An
// absent sync marker means the cache may only contain part of a full sync.
export const completeCachedArtifacts$ = computed(
  (
    get,
    { signal },
  ): ArtifactsPageData | null | Promise<ArtifactsPageData | null> => {
    get(internalArtifactsReload$);
    if (get(internalArtifactsPageSession$) === null) {
      return null;
    }

    const stores = artifactItemCacheStores(get(chatIdb$));
    const readOptions = get(internalArtifactsReadOptions$);

    return (async (): Promise<ArtifactsPageData | null> => {
      if ((await stores.readStore.readLastSyncedAt(signal)) === null) {
        return null;
      }
      const artifacts = await stores.readStore.readRecent(readOptions, signal);
      signal.throwIfAborted();
      return { artifacts };
    })();
  },
);

// Remote pages are normalized and persisted one at a time. This keeps
// IndexedDB as the only complete artifact collection; the synchronization
// computed retains no full cache or remote snapshot.
const internalArtifactsSync$ = computed(
  (get, { signal }): void | Promise<void> => {
    get(internalArtifactsReload$);
    if (get(internalArtifactsPageSession$) === null) {
      return;
    }
    const stores = artifactItemCacheStores(get(chatIdb$));
    const client = get(zeroClient$)(artifactsContract);

    return (async (): Promise<void> => {
      const updatedAfter =
        (await stores.readStore.readLastSyncedAt(signal)) ?? undefined;
      let cursor: string | undefined;
      let syncUntil: string | undefined;
      let fullSync = updatedAfter === undefined;

      for (let page = 0; page < ARTIFACTS_MAX_PAGES; page += 1) {
        const result = await accept(
          client.list({
            query: {
              limit: ARTIFACTS_PAGE_SIZE,
              cursor,
              updatedAfter,
            },
            fetchOptions: { signal },
          }),
          [200],
          signal,
        );
        signal.throwIfAborted();

        if (page === 0) {
          syncUntil = result.body.syncUntil;
          fullSync ||= syncUntil === undefined;
          if (fullSync) {
            await stores.writeStore.beginFullSync(signal);
          }
        }

        const artifacts = result.body.artifacts.map((item) => {
          return artifactItemSchema.parse(item);
        });
        await stores.writeStore.upsertItems(artifacts, signal);

        cursor = result.body.nextCursor ?? undefined;
        if (!cursor) {
          if (syncUntil) {
            await stores.writeStore.finishSync(syncUntil, signal);
          }
          return;
        }
      }

      throw new Error("Artifact pagination exceeded the page limit");
    })();
  },
);

// The page waits for synchronization, then reads just its visible window from
// IndexedDB in updatedAt order. A failed refresh may fall back to an existing
// cache, but remote rows are never rendered directly.
export const artifacts$ = computed(
  (get, { signal }): ArtifactsPageData | Promise<ArtifactsPageData> => {
    if (get(internalArtifactsPageSession$) === null) {
      return { artifacts: [] };
    }

    const sync = Promise.resolve(get(internalArtifactsSync$));
    const stores = artifactItemCacheStores(get(chatIdb$));
    const readOptions = get(internalArtifactsReadOptions$);

    return (async (): Promise<ArtifactsPageData> => {
      const syncResult = await settle(sync, signal);
      if (
        !syncResult.ok &&
        (await stores.readStore.readLastSyncedAt(signal)) === null
      ) {
        throw syncResult.error;
      }
      const artifacts = await stores.readStore.readRecent(readOptions, signal);
      signal.throwIfAborted();
      return { artifacts };
    })();
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
