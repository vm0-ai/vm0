import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import {
  artifactCatalogContract,
  type ArtifactCatalogKind,
  type ArtifactDetail,
  type ArtifactSummary,
} from "@vm0/api-contracts/contracts/artifact-catalog";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { onRejection } from "../utils.ts";

// First screen and every scroll step request the same page size. The server
// orders by `(createdAt, id)` and never reorders on update, so a cursor stays
// valid for the whole scroll session.
const ARTIFACT_CATALOG_PAGE_SIZE = 60;

export interface ArtifactCatalogPage {
  readonly artifacts: readonly ArtifactSummary[];
  readonly nextCursor: string | null;
}

export interface ArtifactCatalogSignals {
  readonly selectedKind$: Computed<ArtifactCatalogKind | null>;
  readonly setKind$: Command<void, [ArtifactCatalogKind | null]>;
  readonly reload$: Command<void, []>;
  readonly catalog$: Computed<Promise<ArtifactCatalogPage>>;
  readonly loadMore$: Command<Promise<void>, [AbortSignal]>;
  readonly selectArtifact$: Command<void, [string | null]>;
  readonly selectedArtifactDetail$: Computed<Promise<ArtifactDetail | null>>;
  readonly subscribeCatalogChanged$: Command<Promise<void>, [AbortSignal]>;
}

interface CatalogPagingState {
  readonly chatThreadId: string | undefined;
  readonly kind$: State<ArtifactCatalogKind | null>;
  readonly reloadVersion$: State<number>;
  readonly generation$: State<number>;
  readonly pages$: State<readonly ArtifactCatalogPage[]>;
  readonly fetchedCursors$: State<ReadonlySet<string>>;
}

function createCatalogPagingSignals(paging: CatalogPagingState): {
  readonly catalog$: Computed<Promise<ArtifactCatalogPage>>;
  readonly loadMore$: Command<Promise<void>, [AbortSignal]>;
} {
  const { chatThreadId } = paging;

  const firstPage$ = computed(
    async (get, { signal }): Promise<ArtifactCatalogPage> => {
      get(paging.reloadVersion$);
      const kind = get(paging.kind$);
      const client = get(zeroClient$)(artifactCatalogContract);
      const result = await accept(
        client.list({
          query: {
            limit: ARTIFACT_CATALOG_PAGE_SIZE,
            ...(kind ? { kind } : {}),
            ...(chatThreadId ? { chatThreadId } : {}),
          },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      return result.body;
    },
  );

  /**
   * Everything loaded so far, in server order. Reading this triggers the first
   * page fetch; `loadMore$` appends the rest.
   */
  const catalog$ = computed(async (get): Promise<ArtifactCatalogPage> => {
    const firstPage = await get(firstPage$);
    const appendedPages = get(paging.pages$);
    const lastPage = appendedPages.at(-1) ?? firstPage;
    return {
      artifacts: [
        ...firstPage.artifacts,
        ...appendedPages.flatMap((page) => {
          return page.artifacts;
        }),
      ],
      nextCursor: lastPage.nextCursor,
    };
  });

  const loadMore$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const generation = get(paging.generation$);
      const kind = get(paging.kind$);
      const loaded = await get(catalog$);
      signal.throwIfAborted();
      if (get(paging.generation$) !== generation) {
        return;
      }
      const cursor = loaded.nextCursor;
      if (!cursor || get(paging.fetchedCursors$).has(cursor)) {
        return;
      }
      set(paging.fetchedCursors$, (cursors) => {
        return new Set([...cursors, cursor]);
      });

      const client = get(zeroClient$)(artifactCatalogContract);
      const result = await onRejection(
        accept(
          client.list({
            query: {
              limit: ARTIFACT_CATALOG_PAGE_SIZE,
              cursor,
              ...(kind ? { kind } : {}),
              ...(chatThreadId ? { chatThreadId } : {}),
            },
            fetchOptions: { signal },
          }),
          [200],
          signal,
        ),
        () => {
          if (get(paging.generation$) !== generation) {
            return;
          }
          set(paging.fetchedCursors$, (cursors) => {
            const retryableCursors = new Set(cursors);
            retryableCursors.delete(cursor);
            return retryableCursors;
          });
        },
      );
      signal.throwIfAborted();
      if (get(paging.generation$) !== generation) {
        return;
      }
      set(paging.pages$, (pages) => {
        return [...pages, result.body];
      });
    },
  );

  return { catalog$, loadMore$ };
}

/**
 * One independent catalog view. The `/artifacts` page holds a module-global
 * instance over the whole org catalog; each chat thread sidebar holds its own
 * instance narrowed by `chatThreadId`. Loaded pages live in the instance, so a
 * closed sidebar reopens on its cache while `reload$` refreshes the first page.
 */
export function createArtifactCatalogSignals(
  options: { readonly chatThreadId?: string } = {},
): ArtifactCatalogSignals {
  const internalKind$ = state<ArtifactCatalogKind | null>(null);
  const internalReload$ = state(0);
  const internalGeneration$ = state(0);
  const internalPages$ = state<readonly ArtifactCatalogPage[]>([]);
  // Cursors already handed to the server. Scroll events fire faster than a
  // page resolves, so this keeps one request per cursor without a loading flag.
  const internalFetchedCursors$ = state<ReadonlySet<string>>(new Set());
  const internalSelectedArtifactId$ = state<string | null>(null);

  const resetPages$ = command(({ set }) => {
    set(internalPages$, []);
    set(internalFetchedCursors$, new Set());
    set(internalGeneration$, (generation) => {
      return generation + 1;
    });
  });

  const setKind$ = command(({ set }, kind: ArtifactCatalogKind | null) => {
    set(internalKind$, kind);
    set(resetPages$);
  });

  /**
   * Re-read the first page. Later pages are dropped rather than re-fetched:
   * new artifacts always land at the head, so the first page is the only one
   * that can have changed.
   */
  const reload$ = command(({ set }) => {
    set(resetPages$);
    set(internalReload$, (version) => {
      return version + 1;
    });
  });

  const { catalog$, loadMore$ } = createCatalogPagingSignals({
    chatThreadId: options.chatThreadId,
    kind$: internalKind$,
    reloadVersion$: internalReload$,
    generation$: internalGeneration$,
    pages$: internalPages$,
    fetchedCursors$: internalFetchedCursors$,
  });

  const selectArtifact$ = command(({ set }, artifactId: string | null) => {
    set(internalSelectedArtifactId$, artifactId);
  });

  /**
   * Kind-specific detail for the opened card. Null while nothing is selected
   * or when the artifact no longer exists, so the list never pays for detail
   * queries it does not render and a deleted artifact renders as unavailable.
   */
  const selectedArtifactDetail$ = computed(
    async (get, { signal }): Promise<ArtifactDetail | null> => {
      get(internalReload$);
      const artifactId = get(internalSelectedArtifactId$);
      if (!artifactId) {
        return null;
      }
      const client = get(zeroClient$)(artifactCatalogContract);
      const result = await accept(
        client.get({
          params: { artifactId },
          fetchOptions: { signal },
        }),
        [200, 404],
        signal,
      );
      return result.status === 404 ? null : result.body;
    },
  );

  /**
   * Reload the first page whenever the catalog changes for this user.
   */
  const subscribeCatalogChanged$ = command(
    async ({ set }, signal: AbortSignal) => {
      const onChanged$ = command(({ set }) => {
        set(reload$);
        return false;
      });
      await set(
        setAblyLoop$,
        { topic: "artifactCatalogChanged", loopCommand$: onChanged$ },
        signal,
      );
    },
  );

  return {
    selectedKind$: computed((get) => {
      return get(internalKind$);
    }),
    setKind$,
    reload$,
    catalog$,
    loadMore$,
    selectArtifact$,
    selectedArtifactDetail$,
    subscribeCatalogChanged$,
  };
}
