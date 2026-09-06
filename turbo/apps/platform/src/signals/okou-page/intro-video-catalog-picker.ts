import {
  introVideoPresenterContract,
  type IntroVideoAvatar,
  type IntroVideoStyle,
} from "@okouai/api-contracts/contracts/intro-video-presenter";
import { command, computed, state, type Command, type Computed } from "ccstate";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { pageSignal$ } from "../page-signal.ts";
import {
  createDeferredPromise,
  onRef,
  onRejection,
  withCleanup,
} from "../utils.ts";

const INTRO_VIDEO_CATALOG_PAGE_SIZE = 24;

interface CatalogPage<T> {
  readonly items: readonly T[];
  readonly hasNext: boolean;
  readonly nextToken: string | null;
}

interface IntroVideoCatalogPage<T> extends CatalogPage<T> {
  readonly generation: number;
}

type CatalogLoader<T> = (
  token: string | undefined,
  signal?: AbortSignal,
) => Promise<CatalogPage<T>>;

function createCatalogSentinelRef(
  loadMore$: Command<Promise<void>, [AbortSignal]>,
) {
  return onRef<HTMLDivElement>(
    command(async ({ get, set }, node: HTMLDivElement, signal: AbortSignal) => {
      const pageSignal = get(pageSignal$);
      const visible = createDeferredPromise<void>(signal);
      const root = node.closest("[data-intro-video-catalog-scroll]");
      const observer = new IntersectionObserver(
        (entries) => {
          if (
            !visible.settled() &&
            entries.some((entry) => {
              return entry.isIntersecting;
            })
          ) {
            observer.disconnect();
            visible.resolve();
          }
        },
        {
          root,
          // Prefetch one viewport ahead, rather than a fixed desktop pixel threshold.
          rootMargin: `0px 0px ${root?.clientHeight ?? 0}px 0px`,
        },
      );
      observer.observe(node);
      await withCleanup(visible.promise, () => {
        observer.disconnect();
      });
      signal.throwIfAborted();
      // Loading replaces the sentinel with a spinner; the request belongs to the page.
      await set(loadMore$, pageSignal);
    }),
  );
}

export function createPagedCatalogSignals<T>(
  loadPage$: Computed<CatalogLoader<T>>,
) {
  const internalPages$ = state<readonly CatalogPage<T>[]>([]);
  const internalRequestedTokens$ = state<readonly string[]>([]);
  const internalGeneration$ = state(0);
  const internalPaging$ = state<Promise<void> | null>(null);

  const firstPage$ = computed((get) => {
    get(internalGeneration$);
    return get(loadPage$)(undefined);
  });

  const reload$ = command(({ set }) => {
    set(internalPages$, []);
    set(internalRequestedTokens$, []);
    set(internalPaging$, null);
    set(internalGeneration$, (generation) => {
      return generation + 1;
    });
  });

  const catalogPage$ = computed(
    async (get): Promise<IntroVideoCatalogPage<T>> => {
      const generation = get(internalGeneration$);
      const firstPage = await get(firstPage$);
      const pages = get(internalPages$);
      const lastPage = pages.at(-1) ?? firstPage;
      return {
        items: [
          ...firstPage.items,
          ...pages.flatMap((page) => {
            return page.items;
          }),
        ],
        hasNext: lastPage.hasNext,
        nextToken: lastPage.nextToken,
        generation,
      };
    },
  );

  const appendPage$ = command(
    async (
      { get, set },
      request: { readonly token: string; readonly generation: number },
      signal: AbortSignal,
    ): Promise<void> => {
      const { token, generation } = request;
      const next = await get(loadPage$)(token, signal);
      signal.throwIfAborted();
      if (get(internalGeneration$) !== generation) {
        return;
      }
      set(internalPages$, (pages) => {
        return [...pages, next];
      });
      await get(catalogPage$);
      signal.throwIfAborted();
    },
  );

  const loadMore$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const generation = get(internalGeneration$);
      const current = await get(catalogPage$);
      signal.throwIfAborted();
      const token = current.nextToken;
      if (
        get(internalGeneration$) !== generation ||
        !current.hasNext ||
        !token ||
        get(internalRequestedTokens$).includes(token)
      ) {
        return;
      }
      set(internalRequestedTokens$, (tokens) => {
        return [...tokens, token];
      });
      const request = onRejection(
        set(appendPage$, { token, generation }, signal),
        () => {
          if (get(internalGeneration$) === generation) {
            set(internalRequestedTokens$, (tokens) => {
              return tokens.filter((candidate) => {
                return candidate !== token;
              });
            });
          }
        },
      );
      set(internalPaging$, request);
      await request;
    },
  );

  return {
    catalogPage$,
    paging$: computed((get) => {
      return get(internalPaging$);
    }),
    generation$: computed((get) => {
      return get(internalGeneration$);
    }),
    loadMore$,
    setSentinelRef$: createCatalogSentinelRef(loadMore$),
    reload$,
  };
}

const avatarPageLoader$ = computed((get): CatalogLoader<IntroVideoAvatar> => {
  const client = get(apiClient$)(introVideoPresenterContract, {
    apiBase: "api",
  });
  return async (token, signal) => {
    const result = await accept(
      client.avatars({
        query: {
          pageSize: INTRO_VIDEO_CATALOG_PAGE_SIZE,
          ...(token ? { token } : {}),
        },
        ...(signal ? { fetchOptions: { signal } } : {}),
      }),
      [200],
      signal,
    );
    return {
      items: result.body.avatars,
      hasNext: result.body.hasMore && result.body.nextToken !== null,
      nextToken: result.body.nextToken,
    };
  };
});

const stylePageLoader$ = computed((get): CatalogLoader<IntroVideoStyle> => {
  const client = get(apiClient$)(introVideoPresenterContract, {
    apiBase: "api",
  });
  return async (token, signal) => {
    const result = await accept(
      client.styles({
        query: {
          pageSize: INTRO_VIDEO_CATALOG_PAGE_SIZE,
          ...(token ? { token } : {}),
        },
        ...(signal ? { fetchOptions: { signal } } : {}),
      }),
      [200],
      signal,
    );
    return {
      items: result.body.styles,
      hasNext: result.body.hasMore && result.body.nextToken !== null,
      nextToken: result.body.nextToken,
    };
  };
});

export const introVideoAvatarPickerSignals =
  createPagedCatalogSignals(avatarPageLoader$);

export const introVideoStylePickerSignals =
  createPagedCatalogSignals(stylePageLoader$);
