import { command, computed, state, type Computed } from "ccstate";
import {
  zeroAvatarVideoContract,
  type ZeroAvatarVideoAvatar,
  type ZeroAvatarVideoAvatarsQuery,
  type ZeroAvatarVideoVoice,
  type ZeroAvatarVideoVoicesQuery,
} from "@vm0/api-contracts/contracts/zero-avatar-video";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { onRejection } from "../utils.ts";

const AVATAR_TEMPLATE_PAGE_SIZE = 24;
const AVATAR_TEMPLATE_FILTER_OPTIONS_PAGE_SIZE = 100;

interface AvatarTemplateCatalogPage {
  readonly avatars: readonly ZeroAvatarVideoAvatar[];
  readonly hasNext: boolean;
}

interface AvatarTemplateVoiceCatalogPage {
  readonly voices: readonly ZeroAvatarVideoVoice[];
  readonly hasNext: boolean;
}

interface AvatarTemplateFilters {
  readonly aspectRatio: "portrait" | "landscape";
  readonly style: ZeroAvatarVideoAvatarsQuery["style"];
  readonly gender: ZeroAvatarVideoAvatarsQuery["gender"];
  readonly age: ZeroAvatarVideoAvatarsQuery["age"];
  readonly scene: ZeroAvatarVideoAvatarsQuery["scene"];
  readonly ethnicity: ZeroAvatarVideoAvatarsQuery["ethnicity"];
}

interface AvatarTemplateVoiceFilters {
  readonly language: ZeroAvatarVideoVoicesQuery["language"];
  readonly gender: ZeroAvatarVideoVoicesQuery["gender"];
  readonly age: ZeroAvatarVideoVoicesQuery["age"];
  readonly useCase: ZeroAvatarVideoVoicesQuery["useCase"];
}

interface AvatarTemplateVoiceFilterOptions {
  readonly languages: readonly string[];
  readonly useCases: readonly string[];
}

interface OffsetCatalogPage<T> {
  readonly items: readonly T[];
  readonly hasNext: boolean;
}

type LoadOffsetCatalogPage<T> = (
  page: number,
  signal: AbortSignal,
) => Promise<OffsetCatalogPage<T>>;

function emptyAvatarTemplateFilters(): AvatarTemplateFilters {
  return {
    aspectRatio: "portrait",
    style: undefined,
    gender: undefined,
    age: undefined,
    scene: undefined,
    ethnicity: undefined,
  };
}

function emptyAvatarTemplateVoiceFilters(): AvatarTemplateVoiceFilters {
  return {
    language: undefined,
    gender: undefined,
    age: undefined,
    useCase: undefined,
  };
}

function voiceGenderForAvatar(
  avatarGender: string | undefined,
  fallback: AvatarTemplateVoiceFilters["gender"],
): AvatarTemplateVoiceFilters["gender"] {
  const normalized = avatarGender?.toLocaleLowerCase();
  if (normalized === "female" || normalized === "male") {
    return normalized;
  }
  return fallback;
}

function voiceAgeForAvatar(
  avatarAge: string | undefined,
): AvatarTemplateVoiceFilters["age"] {
  switch (avatarAge?.toLocaleLowerCase()) {
    case "young":
    case "young_adult": {
      return "young";
    }
    case "adult":
    case "middle_aged": {
      return "middle_aged";
    }
    case "old":
    case "senior": {
      return "old";
    }
    default: {
      return undefined;
    }
  }
}

function voiceFiltersForAvatar(
  avatar: ZeroAvatarVideoAvatar,
  filters: AvatarTemplateFilters,
): AvatarTemplateVoiceFilters {
  return {
    language: undefined,
    gender: voiceGenderForAvatar(avatar.gender, filters.gender),
    age: voiceAgeForAvatar(avatar.age ?? filters.age),
    useCase: undefined,
  };
}

function createOffsetCatalogPagingSignals<T>(
  loadPage$: Computed<LoadOffsetCatalogPage<T>>,
) {
  const internalPages$ = state<readonly OffsetCatalogPage<T>[]>([]);
  const internalRequestedPages$ = state<ReadonlySet<number>>(new Set());
  const internalLoadingMore$ = state(false);
  const internalGeneration$ = state(0);
  const firstPage$ = computed((get, { signal }) => {
    return get(loadPage$)(1, signal);
  });
  const catalog$ = computed(async (get): Promise<OffsetCatalogPage<T>> => {
    const firstPage = await get(firstPage$);
    const appendedPages = get(internalPages$);
    const lastPage = appendedPages.at(-1) ?? firstPage;
    return {
      items: [
        ...firstPage.items,
        ...appendedPages.flatMap((page) => {
          return page.items;
        }),
      ],
      hasNext: lastPage.hasNext,
    };
  });
  const reset$ = command(({ set }) => {
    set(internalPages$, []);
    set(internalRequestedPages$, new Set());
    set(internalLoadingMore$, false);
    set(internalGeneration$, (generation) => {
      return generation + 1;
    });
  });
  const loadMore$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const generation = get(internalGeneration$);
      const loaded = await get(catalog$);
      signal.throwIfAborted();
      if (get(internalGeneration$) !== generation || !loaded.hasNext) {
        return;
      }
      const nextPage = get(internalPages$).length + 2;
      if (get(internalRequestedPages$).has(nextPage)) {
        return;
      }
      set(internalRequestedPages$, (pages) => {
        return new Set([...pages, nextPage]);
      });
      set(internalLoadingMore$, true);
      const loadPage = get(loadPage$);
      const next = await onRejection(loadPage(nextPage, signal), () => {
        if (get(internalGeneration$) !== generation) {
          return;
        }
        set(internalLoadingMore$, false);
        set(internalRequestedPages$, (pages) => {
          const retryablePages = new Set(pages);
          retryablePages.delete(nextPage);
          return retryablePages;
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
  const loadingMore$ = computed((get) => {
    return get(internalLoadingMore$);
  });
  return { catalog$, reset$, loadMore$, loadingMore$ };
}

function avatarCatalogQuery(
  filters: AvatarTemplateFilters,
  page: number,
): ZeroAvatarVideoAvatarsQuery {
  return {
    page,
    pageSize: AVATAR_TEMPLATE_PAGE_SIZE,
    aspectRatio: filters.aspectRatio,
    ...(filters.style ? { style: filters.style } : {}),
    ...(filters.gender ? { gender: filters.gender } : {}),
    ...(filters.age ? { age: filters.age } : {}),
    ...(filters.scene ? { scene: filters.scene } : {}),
    ...(filters.ethnicity ? { ethnicity: filters.ethnicity } : {}),
  };
}

function voiceCatalogQuery(
  filters: AvatarTemplateVoiceFilters,
  page: number,
): ZeroAvatarVideoVoicesQuery {
  return {
    page,
    pageSize: AVATAR_TEMPLATE_PAGE_SIZE,
    ...(filters.language ? { language: filters.language } : {}),
    ...(filters.gender ? { gender: filters.gender } : {}),
    ...(filters.age ? { age: filters.age } : {}),
    ...(filters.useCase ? { useCase: filters.useCase } : {}),
  };
}

function createAvatarTemplateCatalogSignals() {
  const internalFilters$ = state<AvatarTemplateFilters>(
    emptyAvatarTemplateFilters(),
  );
  const loadPage$ = computed(
    (get): LoadOffsetCatalogPage<ZeroAvatarVideoAvatar> => {
      const client = get(zeroClient$)(zeroAvatarVideoContract, {
        apiBase: "api",
      });
      const filters = get(internalFilters$);
      return async (page, signal) => {
        const result = await accept(
          client.avatars({
            query: avatarCatalogQuery(filters, page),
            fetchOptions: { signal },
          }),
          [200],
          signal,
        );
        return {
          items: result.body.avatars,
          hasNext: result.body.avatars.length === AVATAR_TEMPLATE_PAGE_SIZE,
        };
      };
    },
  );
  const paging =
    createOffsetCatalogPagingSignals<ZeroAvatarVideoAvatar>(loadPage$);
  const avatarTemplateFilters$ = computed((get) => {
    return get(internalFilters$);
  });
  const setAvatarTemplateFilters$ = command(
    ({ set }, filters: AvatarTemplateFilters) => {
      set(internalFilters$, filters);
      set(paging.reset$);
    },
  );
  const avatarTemplateCatalogPage$ = computed(
    async (get): Promise<AvatarTemplateCatalogPage> => {
      const catalog = await get(paging.catalog$);
      return {
        avatars: catalog.items,
        hasNext: catalog.hasNext,
      };
    },
  );

  return {
    avatarTemplateFilters$,
    setAvatarTemplateFilters$,
    avatarTemplateCatalogPage$,
    loadMoreAvatarTemplates$: paging.loadMore$,
    avatarTemplatesLoadingMore$: paging.loadingMore$,
  };
}

function createAvatarTemplateVoiceCatalogSignals() {
  const internalVoiceFilters$ = state<AvatarTemplateVoiceFilters>(
    emptyAvatarTemplateVoiceFilters(),
  );
  const loadPage$ = computed(
    (get): LoadOffsetCatalogPage<ZeroAvatarVideoVoice> => {
      const client = get(zeroClient$)(zeroAvatarVideoContract, {
        apiBase: "api",
      });
      const filters = get(internalVoiceFilters$);
      return async (page, signal) => {
        const result = await accept(
          client.voices({
            query: voiceCatalogQuery(filters, page),
            fetchOptions: { signal },
          }),
          [200],
          signal,
        );
        return {
          items: result.body.voices,
          hasNext: result.body.hasMore,
        };
      };
    },
  );
  const paging =
    createOffsetCatalogPagingSignals<ZeroAvatarVideoVoice>(loadPage$);
  const avatarTemplateVoiceFilters$ = computed((get) => {
    return get(internalVoiceFilters$);
  });
  const setAvatarTemplateVoiceFilters$ = command(
    ({ set }, filters: AvatarTemplateVoiceFilters) => {
      set(internalVoiceFilters$, filters);
      set(paging.reset$);
    },
  );
  const avatarTemplateVoiceFilterOptions$ = computed(
    async (get, { signal }): Promise<AvatarTemplateVoiceFilterOptions> => {
      const client = get(zeroClient$)(zeroAvatarVideoContract, {
        apiBase: "api",
      });
      const languages = new Set<string>();
      const useCases = new Set<string>();
      let page = 1;
      let hasMore: boolean;
      do {
        const result = await accept(
          client.voices({
            query: {
              page,
              pageSize: AVATAR_TEMPLATE_FILTER_OPTIONS_PAGE_SIZE,
            },
            fetchOptions: { signal },
          }),
          [200],
          signal,
        );
        for (const language of result.body.filterOptions?.languages ?? []) {
          languages.add(language);
        }
        for (const useCase of result.body.filterOptions?.useCases ?? []) {
          useCases.add(useCase);
        }
        hasMore = result.body.hasMore;
        page += 1;
      } while (hasMore);
      return {
        languages: Array.from(languages).sort(),
        useCases: Array.from(useCases).sort(),
      };
    },
  );
  const avatarTemplateVoiceCatalogPage$ = computed(
    async (get): Promise<AvatarTemplateVoiceCatalogPage> => {
      const catalog = await get(paging.catalog$);
      return {
        voices: catalog.items,
        hasNext: catalog.hasNext,
      };
    },
  );

  return {
    avatarTemplateVoiceFilters$,
    setAvatarTemplateVoiceFilters$,
    avatarTemplateVoiceFilterOptions$,
    avatarTemplateVoiceCatalogPage$,
    loadMoreAvatarTemplateVoices$: paging.loadMore$,
    avatarTemplateVoicesLoadingMore$: paging.loadingMore$,
    resetAvatarTemplateVoiceCatalog$: paging.reset$,
  };
}

export function createAvatarTemplatePickerSignals() {
  const avatarCatalog = createAvatarTemplateCatalogSignals();
  const voiceCatalog = createAvatarTemplateVoiceCatalogSignals();
  const internalSelectedAvatar$ = state<ZeroAvatarVideoAvatar | null>(null);
  const selectedAvatarTemplateForVoice$ = computed((get) => {
    return get(internalSelectedAvatar$);
  });
  const selectAvatarTemplateForVoice$ = command(
    ({ get, set }, avatar: ZeroAvatarVideoAvatar) => {
      const avatarFilters = get(avatarCatalog.avatarTemplateFilters$);
      set(
        voiceCatalog.setAvatarTemplateVoiceFilters$,
        voiceFiltersForAvatar(avatar, avatarFilters),
      );
      set(internalSelectedAvatar$, avatar);
    },
  );
  const clearAvatarTemplateVoiceSelection$ = command(({ set }) => {
    set(voiceCatalog.resetAvatarTemplateVoiceCatalog$);
    set(internalSelectedAvatar$, null);
  });

  return {
    ...avatarCatalog,
    ...voiceCatalog,
    selectedAvatarTemplateForVoice$,
    selectAvatarTemplateForVoice$,
    clearAvatarTemplateVoiceSelection$,
  };
}
