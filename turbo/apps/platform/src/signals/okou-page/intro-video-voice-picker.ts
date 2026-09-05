import { command, computed, state } from "ccstate";
import {
  introVideoPresenterContract,
  type IntroVideoVoice,
  type IntroVideoVoicesQuery,
} from "@okouai/api-contracts/contracts/intro-video-presenter";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { onRejection } from "../utils.ts";

const INTRO_VIDEO_VOICE_PAGE_SIZE = 24;

interface IntroVideoVoiceFilters {
  readonly language: IntroVideoVoicesQuery["language"];
  readonly gender: IntroVideoVoicesQuery["gender"];
}

interface IntroVideoVoicePage {
  readonly voices: readonly IntroVideoVoice[];
  readonly hasNext: boolean;
  readonly nextToken: string | null;
}

interface IntroVideoVoiceCatalogPage extends IntroVideoVoicePage {
  readonly generation: number;
}

function emptyFilters(): IntroVideoVoiceFilters {
  return { language: undefined, gender: undefined };
}

function createIntroVideoVoicePickerSignals() {
  const internalFilters$ = state<IntroVideoVoiceFilters>(emptyFilters());
  const internalPages$ = state<readonly IntroVideoVoicePage[]>([]);
  const internalRequestedTokens$ = state<readonly string[]>([]);
  const internalLoadingMore$ = state(false);
  const internalGeneration$ = state(0);

  const loadPage$ = computed((get) => {
    const client = get(apiClient$)(introVideoPresenterContract, {
      apiBase: "api",
    });
    const filters = get(internalFilters$);
    return async (
      token: string | undefined,
      signal?: AbortSignal,
    ): Promise<IntroVideoVoicePage> => {
      const result = await accept(
        client.voices({
          query: {
            pageSize: INTRO_VIDEO_VOICE_PAGE_SIZE,
            ...(token ? { token } : {}),
            ...(filters.language ? { language: filters.language } : {}),
            ...(filters.gender ? { gender: filters.gender } : {}),
          },
          ...(signal ? { fetchOptions: { signal } } : {}),
        }),
        [200],
        signal,
      );
      return {
        voices: result.body.voices,
        hasNext: result.body.hasMore && result.body.nextToken !== null,
        nextToken: result.body.nextToken,
      };
    };
  });

  const firstPage$ = computed((get) => {
    return get(loadPage$)(undefined);
  });

  const introVideoVoiceCatalogPage$ = computed(
    async (get): Promise<IntroVideoVoiceCatalogPage> => {
      const generation = get(internalGeneration$);
      const firstPage = await get(firstPage$);
      const pages = get(internalPages$);
      const lastPage = pages.at(-1) ?? firstPage;
      return {
        voices: [
          ...firstPage.voices,
          ...pages.flatMap((page) => {
            return page.voices;
          }),
        ],
        hasNext: lastPage.hasNext,
        nextToken: lastPage.nextToken,
        generation,
      };
    },
  );

  const reset$ = command(({ set }) => {
    set(internalPages$, []);
    set(internalRequestedTokens$, []);
    set(internalLoadingMore$, false);
    set(internalGeneration$, (generation) => {
      return generation + 1;
    });
  });

  const setFilters$ = command(({ set }, filters: IntroVideoVoiceFilters) => {
    set(internalFilters$, filters);
    set(reset$);
  });

  const loadMore$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const generation = get(internalGeneration$);
      const current = await get(introVideoVoiceCatalogPage$);
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
    filters$: computed((get) => {
      return get(internalFilters$);
    }),
    setFilters$,
    catalogPage$: introVideoVoiceCatalogPage$,
    generation$: computed((get) => {
      return get(internalGeneration$);
    }),
    loadMore$,
    loadingMore$: computed((get) => {
      return get(internalLoadingMore$);
    }),
  };
}

export const introVideoVoicePickerSignals =
  createIntroVideoVoicePickerSignals();
