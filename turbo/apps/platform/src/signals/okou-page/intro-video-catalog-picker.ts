import {
  introVideoPresenterContract,
  type IntroVideoAvatar,
  type IntroVideoStyle,
} from "@okouai/api-contracts/contracts/intro-video-presenter";
import { command, computed, state, type Computed } from "ccstate";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { onRejection } from "../utils.ts";

const INTRO_VIDEO_CATALOG_PAGE_SIZE = 24;

interface CatalogPage<T> {
  readonly items: readonly T[];
  readonly hasNext: boolean;
  readonly nextToken: string | null;
}

export interface IntroVideoCatalogPage<T> extends CatalogPage<T> {
  readonly generation: number;
}

type CatalogLoader<T> = (
  token: string | undefined,
  signal?: AbortSignal,
) => Promise<CatalogPage<T>>;

function createPagedCatalogSignals<T>(loadPage$: Computed<CatalogLoader<T>>) {
  const internalPages$ = state<readonly CatalogPage<T>[]>([]);
  const internalRequestedTokens$ = state<readonly string[]>([]);
  const internalLoadingMore$ = state(false);
  const internalGeneration$ = state(0);

  const firstPage$ = computed((get) => {
    return get(loadPage$)(undefined);
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
      set(internalLoadingMore$, true);
      const loadPage = get(loadPage$);
      const next = await onRejection(loadPage(token, signal), () => {
        if (get(internalGeneration$) !== generation) {
          return;
        }
        set(internalLoadingMore$, false);
        set(internalRequestedTokens$, (tokens) => {
          return tokens.filter((candidate) => {
            return candidate !== token;
          });
        });
      });
      signal.throwIfAborted();
      if (get(internalGeneration$) !== generation) {
        return;
      }
      set(internalPages$, (pages) => {
        return [...pages, next];
      });
      set(internalLoadingMore$, false);
    },
  );

  return {
    catalogPage$,
    generation$: computed((get) => {
      return get(internalGeneration$);
    }),
    loadingMore$: computed((get) => {
      return get(internalLoadingMore$);
    }),
    loadMore$,
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
