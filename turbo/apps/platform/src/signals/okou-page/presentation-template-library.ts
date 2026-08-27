import { command, computed, state, type Computed, type State } from "ccstate";
import { delay } from "signal-timers";
import {
  MAX_PRESENTATION_TEMPLATE_PAGES,
  presentationTemplatesContract,
  PRESENTATION_TEMPLATE_URL_TTL_SECONDS,
  type PresentationTemplateCatalogEntry,
  type PresentationTemplateDetail,
  type PresentationTemplatePreviewAsset,
  type PresentationTemplateSummary,
  type UpdatePresentationTemplateBody,
} from "@okouai/api-contracts/contracts/presentation-templates";

import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { onRef, setLoop } from "../utils.ts";
import { presentationTemplateImportEnabled$ } from "./presentation-template-import.ts";

export type { PresentationTemplateDetail, PresentationTemplateSummary };

type ImportedPresentationTemplateDetailLookup = (
  templateId: string,
) => Computed<Promise<PresentationTemplateDetail | null>>;

interface ImportedPresentationTemplateDetailResolver {
  readonly resolve: ImportedPresentationTemplateDetailLookup;
  readonly evict: (templateId: string) => void;
}

const presentationTemplatesVersion$ = state(0);
/**
 * A successful local delete permanently removes the database row. Keep its ID
 * hidden for the rest of this app session so an older in-flight catalog cannot
 * resurrect either the card or its preview cache.
 */
const deletedPresentationTemplateIds$ = state<ReadonlySet<string>>(new Set());
const importedPresentationTemplateDeletedIds$ = computed((get) => {
  return get(deletedPresentationTemplateIds$);
});
const PRESENTATION_TEMPLATE_PREVIEW_URL_SAFETY_MS = 45 * 1000;
const PRESENTATION_TEMPLATE_CATALOG_REVALIDATE_AGE_MS =
  (PRESENTATION_TEMPLATE_URL_TTL_SECONDS * 1000 * 2) / 3;

interface ImportedPresentationTemplateCatalog {
  readonly templates: readonly PresentationTemplateCatalogEntry[];
  readonly loadedAtMs: number;
}

interface CachedImportedPresentationTemplateCatalog {
  readonly templates: readonly PresentationTemplateDetail[];
  readonly loadedAtMs: number;
}

/**
 * The decks this workspace member can use. Their own decks come first, then
 * decks other members made visible to the workspace.
 *
 * Answering with an empty catalog while the switch is off is not a fallback for
 * a failed request: the route replies `403` to a caller without the switch, and
 * `accept` would surface that as an error toast on a dialog the user opened to
 * browse built-in templates.
 */
const importedPresentationTemplateCatalog$ = computed(
  async (get): Promise<ImportedPresentationTemplateCatalog> => {
    if (!get(presentationTemplateImportEnabled$)) {
      return { templates: [], loadedAtMs: now() };
    }
    get(presentationTemplatesVersion$);
    const client = get(apiClient$)(presentationTemplatesContract);
    const result = await accept(client.list(), [200]);
    return { templates: result.body, loadedAtMs: now() };
  },
);

/** Refetch the catalog after a mutation or realtime catch-up. */
const refreshPresentationTemplates$ = command(({ get, set }) => {
  set(presentationTemplatesVersion$, get(presentationTemplatesVersion$) + 1);
});

const refreshAndLoadPresentationTemplates$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    set(refreshPresentationTemplates$);
    await get(importedPresentationTemplateCatalog$);
    signal.throwIfAborted();
  },
);

const refreshPresentationTemplatesFromRealtime$ = command(
  async ({ set }, signal: AbortSignal): Promise<boolean> => {
    await set(refreshAndLoadPresentationTemplates$, signal);
    return false;
  },
);

/**
 * A template is published by the analysis runner, outside any composer or
 * browser mutation. Subscribe once at the authenticated workspace boundary so
 * navigation cannot strand a newly published deck in the thread that started
 * the analysis.
 */
export const subscribePresentationTemplatesChanged$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const subscriptions = [
      set(
        setAblyLoop$,
        {
          topic: "presentationTemplatesChanged",
          loopCommand$: refreshPresentationTemplatesFromRealtime$,
          options: { runOnSubscribe: true },
        },
        signal,
      ),
    ];
    // The workspace channel belongs to a non-GA feature. Keeping it behind the
    // same switch means a new app never attaches that channel to an older
    // user-only token for users who cannot use presentation templates.
    if (get(presentationTemplateImportEnabled$)) {
      subscriptions.push(
        set(
          setAblyLoop$,
          {
            scope: "org",
            topic: "presentationTemplatesChanged",
            loopCommand$: refreshPresentationTemplatesFromRealtime$,
            options: { runOnForegroundCatchUp: false },
          },
          signal,
        ),
      );
    }
    await Promise.all(subscriptions);
  },
);

async function resolvePresentationTemplatePreviewAssets(
  createClient: ApiClientFactory,
  previewAssetIds: readonly string[],
  signal: AbortSignal,
): Promise<readonly PresentationTemplatePreviewAsset[]> {
  const uniquePreviewAssetIds = [...new Set(previewAssetIds)];
  const batches: string[][] = [];
  for (
    let index = 0;
    index < uniquePreviewAssetIds.length;
    index += MAX_PRESENTATION_TEMPLATE_PAGES
  ) {
    batches.push(
      uniquePreviewAssetIds.slice(
        index,
        index + MAX_PRESENTATION_TEMPLATE_PAGES,
      ),
    );
  }
  const client = createClient(presentationTemplatesContract);
  const responses = await Promise.all(
    batches.map(async (previewAssetIdBatch) => {
      return await accept(
        client.resolvePreviewUrls({
          body: { previewAssetIds: previewAssetIdBatch },
          fetchOptions: { signal },
        }),
        [200],
      );
    }),
  );
  return responses.flatMap((response) => {
    return response.body.assets;
  });
}

interface ImportedPresentationTemplateCache {
  readonly previewAssetIdsByTemplateId: Map<string, readonly string[]>;
  readonly previewUrlByAssetId: Map<string, PresentationTemplatePreviewAsset>;
}

function evictImportedPresentationTemplateCache(
  cache: ImportedPresentationTemplateCache,
  templateId: string,
): void {
  const removedPreviewAssetIds =
    cache.previewAssetIdsByTemplateId.get(templateId);
  cache.previewAssetIdsByTemplateId.delete(templateId);
  if (removedPreviewAssetIds === undefined) {
    return;
  }
  for (const previewAssetId of removedPreviewAssetIds) {
    cache.previewUrlByAssetId.delete(previewAssetId);
  }
}

function referencedPresentationTemplatePreviewAssetIds(
  cache: ImportedPresentationTemplateCache,
): ReadonlySet<string> {
  return new Set([...cache.previewAssetIdsByTemplateId.values()].flat());
}

function mergePresentationTemplatePreviewAsset(
  cache: ImportedPresentationTemplateCache,
  asset: PresentationTemplatePreviewAsset,
): boolean {
  const existing = cache.previewUrlByAssetId.get(asset.previewAssetId);
  if (
    existing !== undefined &&
    Date.parse(existing.expiresAt) >= Date.parse(asset.expiresAt)
  ) {
    return false;
  }
  cache.previewUrlByAssetId.set(asset.previewAssetId, asset);
  return true;
}

function cachedPresentationTemplatePreviewAsset(
  cache: ImportedPresentationTemplateCache,
  previewAssetId: string,
): PresentationTemplatePreviewAsset {
  const asset = cache.previewUrlByAssetId.get(previewAssetId);
  if (asset === undefined) {
    throw new Error(
      `Presentation template preview is not cached: ${previewAssetId}`,
    );
  }
  return asset;
}

function synchronizeImportedPresentationTemplateCache(
  cache: ImportedPresentationTemplateCache,
  templates: readonly PresentationTemplateCatalogEntry[],
): readonly PresentationTemplateDetail[] {
  const templateIds = new Set(
    templates.map((template) => {
      return template.id;
    }),
  );
  for (const cachedTemplateId of cache.previewAssetIdsByTemplateId.keys()) {
    if (!templateIds.has(cachedTemplateId)) {
      evictImportedPresentationTemplateCache(cache, cachedTemplateId);
    }
  }
  for (const template of templates) {
    const previewAssetIds = template.previewAssets.map((asset) => {
      return asset.previewAssetId;
    });
    const nextPreviewAssetIds = new Set(previewAssetIds);
    for (const previousPreviewAssetId of cache.previewAssetIdsByTemplateId.get(
      template.id,
    ) ?? []) {
      if (!nextPreviewAssetIds.has(previousPreviewAssetId)) {
        cache.previewUrlByAssetId.delete(previousPreviewAssetId);
      }
    }
    for (const asset of template.previewAssets) {
      mergePresentationTemplatePreviewAsset(cache, asset);
    }
    cache.previewAssetIdsByTemplateId.set(template.id, previewAssetIds);
  }
  return templates.map((template) => {
    const previewAssetIds = cache.previewAssetIdsByTemplateId.get(template.id);
    if (previewAssetIds === undefined) {
      throw new Error(
        `Presentation template detail is not cached: ${template.id}`,
      );
    }
    const previewAssets = previewAssetIds.map((previewAssetId) => {
      return cachedPresentationTemplatePreviewAsset(cache, previewAssetId);
    });
    return {
      ...template,
      coverUrl: previewAssets[0]?.url ?? template.coverUrl,
      pageUrls: previewAssets.map((asset) => {
        return asset.url;
      }),
      previewAssets,
    };
  });
}

function createCachedImportedPresentationTemplateCatalog$(
  catalog$: Computed<Promise<ImportedPresentationTemplateCatalog>>,
  cache: ImportedPresentationTemplateCache,
  previewUrlsVersion$: State<number>,
  deletedTemplateIds$: State<ReadonlySet<string>>,
) {
  return computed(
    async (get): Promise<CachedImportedPresentationTemplateCatalog> => {
      get(previewUrlsVersion$);
      const deletedTemplateIds = get(deletedTemplateIds$);
      const catalog = await get(catalog$);
      const retainedTemplates = catalog.templates.filter((template) => {
        return !deletedTemplateIds.has(template.id);
      });
      return {
        ...catalog,
        templates: synchronizeImportedPresentationTemplateCache(
          cache,
          retainedTemplates,
        ),
      };
    },
  );
}

function createImportedPresentationTemplates$(
  catalog$: Computed<Promise<CachedImportedPresentationTemplateCatalog>>,
  deletedTemplateIds$: State<ReadonlySet<string>>,
  updatedTemplates$: State<readonly PresentationTemplateSummary[]>,
) {
  return computed(
    async (get): Promise<readonly PresentationTemplateSummary[]> => {
      const deletedTemplateIds = get(deletedTemplateIds$);
      const updatedTemplates = get(updatedTemplates$);
      return (await get(catalog$)).templates
        .filter((template) => {
          return !deletedTemplateIds.has(template.id);
        })
        .map((template) => {
          const updatedTemplate = updatedTemplates.find((candidate) => {
            return candidate.id === template.id;
          });
          if (
            updatedTemplate === undefined ||
            updatedTemplate.updatedAt <= template.updatedAt
          ) {
            return template;
          }
          return {
            ...template,
            title: updatedTemplate.title,
            visibility: updatedTemplate.visibility,
            updatedAt: updatedTemplate.updatedAt,
          };
        });
    },
  );
}

/**
 * Resolve one detail resource per uploaded template for this composer. The
 * resolver belongs to the composer signal group, so closing that composer
 * releases the whole keyed join instead of retaining template identities at
 * module scope.
 */
function createImportedPresentationTemplateDetailResolver(
  catalog$: Computed<Promise<CachedImportedPresentationTemplateCatalog>>,
): ImportedPresentationTemplateDetailResolver {
  const detailByTemplateId = new Map<
    string,
    Computed<Promise<PresentationTemplateDetail | null>>
  >();
  return {
    resolve: (templateId) => {
      const existing = detailByTemplateId.get(templateId);
      if (existing !== undefined) {
        return existing;
      }
      const detail$ = computed(
        async (get): Promise<PresentationTemplateDetail | null> => {
          return (
            (await get(catalog$)).templates.find((template) => {
              return template.id === templateId;
            }) ?? null
          );
        },
      );
      detailByTemplateId.set(templateId, detail$);
      return detail$;
    },
    evict: (templateId) => {
      detailByTemplateId.delete(templateId);
    },
  };
}

interface ImportedPresentationTemplateHover {
  readonly templateId: string;
  readonly index: number;
}

function createImportedPresentationTemplateHoverSignals() {
  const internalCardHover$ = state<ImportedPresentationTemplateHover | null>(
    null,
  );
  const importedPresentationTemplateCardHover$ = computed((get) => {
    return get(internalCardHover$);
  });
  const setImportedPresentationTemplateCardHover$ = command(
    ({ set }, hover: ImportedPresentationTemplateHover | null) => {
      set(internalCardHover$, hover);
    },
  );
  return {
    internalCardHover$,
    importedPresentationTemplateCardHover$,
    setImportedPresentationTemplateCardHover$,
  };
}

function expiringPresentationTemplatePreviewAssetIds(
  cache: ImportedPresentationTemplateCache,
  requestedAt: number,
): readonly string[] {
  return [...cache.previewUrlByAssetId.values()]
    .filter((asset) => {
      return (
        Date.parse(asset.expiresAt) - requestedAt <=
        PRESENTATION_TEMPLATE_PREVIEW_URL_SAFETY_MS
      );
    })
    .map((asset) => {
      return asset.previewAssetId;
    });
}

function presentationTemplatePreviewRefreshDelayMs(
  cache: ImportedPresentationTemplateCache,
  catalogLoadedAtMs: number,
): number {
  const requestedAt = now();
  const expirations = [...cache.previewUrlByAssetId.values()].map((asset) => {
    return Date.parse(asset.expiresAt);
  });
  if (expirations.length === 0) {
    return Math.max(
      0,
      catalogLoadedAtMs +
        PRESENTATION_TEMPLATE_CATALOG_REVALIDATE_AGE_MS -
        requestedAt,
    );
  }
  return Math.max(
    0,
    Math.min(...expirations) -
      PRESENTATION_TEMPLATE_PREVIEW_URL_SAFETY_MS -
      requestedAt,
  );
}

function createImportedPresentationTemplateUrlRefreshSignals(
  catalog$: Computed<Promise<CachedImportedPresentationTemplateCatalog>>,
  cache: ImportedPresentationTemplateCache,
  previewUrlsVersion$: State<number>,
) {
  const refreshImportedPresentationTemplateUrlsIfExpiring$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      if (cache.previewUrlByAssetId.size === 0) {
        const catalog = await get(catalog$);
        signal.throwIfAborted();
        if (
          now() - catalog.loadedAtMs >=
          PRESENTATION_TEMPLATE_CATALOG_REVALIDATE_AGE_MS
        ) {
          await set(refreshAndLoadPresentationTemplates$, signal);
        }
        return;
      }
      const previewAssetIds = expiringPresentationTemplatePreviewAssetIds(
        cache,
        now(),
      );
      if (previewAssetIds.length === 0) {
        return;
      }
      const assets = await resolvePresentationTemplatePreviewAssets(
        get(apiClient$),
        previewAssetIds,
        signal,
      );
      signal.throwIfAborted();
      const resolvedPreviewAssetIds = new Set(
        assets.map((asset) => {
          return asset.previewAssetId;
        }),
      );
      if (
        previewAssetIds.some((previewAssetId) => {
          return !resolvedPreviewAssetIds.has(previewAssetId);
        })
      ) {
        await set(refreshAndLoadPresentationTemplates$, signal);
        return;
      }
      const referencedPreviewAssetIds =
        referencedPresentationTemplatePreviewAssetIds(cache);
      const updated = assets
        .filter((asset) => {
          return referencedPreviewAssetIds.has(asset.previewAssetId);
        })
        .map((asset) => {
          return mergePresentationTemplatePreviewAsset(cache, asset);
        })
        .includes(true);
      if (updated) {
        set(previewUrlsVersion$, (version) => {
          return version + 1;
        });
      }
    },
  );
  const importedPresentationTemplateUrlRefreshLifecycleRef$ = onRef(
    command(
      async (
        { get, set },
        _element: HTMLSpanElement,
        signal: AbortSignal,
      ): Promise<void> => {
        await setLoop(
          async (loopSignal) => {
            const catalogLoadedAtMs =
              cache.previewUrlByAssetId.size === 0
                ? (await get(catalog$)).loadedAtMs
                : now();
            loopSignal.throwIfAborted();
            await delay(
              presentationTemplatePreviewRefreshDelayMs(
                cache,
                catalogLoadedAtMs,
              ),
              { signal: loopSignal },
            );
            await set(
              refreshImportedPresentationTemplateUrlsIfExpiring$,
              loopSignal,
            );
            return false;
          },
          0,
          signal,
          { retryTransientErrors: false },
        );
      },
    ),
  );
  return { importedPresentationTemplateUrlRefreshLifecycleRef$ };
}

function createImportedPresentationTemplateDetailSignals(
  resolveDetail$: ImportedPresentationTemplateDetailLookup,
) {
  const internalRequestedTemplateId$ = state<string | null>(null);
  const importedPresentationTemplateRequestedId$ = computed((get) => {
    return get(internalRequestedTemplateId$);
  });
  const importedPresentationTemplateDetail$ = computed(
    async (get): Promise<PresentationTemplateDetail | null> => {
      const templateId = get(internalRequestedTemplateId$);
      if (templateId === null) {
        return null;
      }
      return await get(resolveDetail$(templateId));
    },
  );
  const requestImportedPresentationTemplateDetail$ = command(
    ({ set }, templateId: string) => {
      set(internalRequestedTemplateId$, templateId);
    },
  );
  return {
    internalRequestedTemplateId$,
    importedPresentationTemplateRequestedId$,
    importedPresentationTemplateDetail$,
    requestImportedPresentationTemplateDetail$,
  };
}

function createUpdateImportedPresentationTemplate$(
  updatedTemplates$: State<readonly PresentationTemplateSummary[]>,
) {
  return command(
    async (
      { get, set },
      templateId: string,
      body: UpdatePresentationTemplateBody,
      signal: AbortSignal,
    ): Promise<void> => {
      const client = get(apiClient$)(presentationTemplatesContract);
      const result = await accept(
        client.update({
          params: { templateId },
          body,
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      set(updatedTemplates$, (updatedTemplates) => {
        return [
          ...updatedTemplates.filter((template) => {
            return template.id !== templateId;
          }),
          result.body,
        ];
      });
    },
  );
}

/** Dialog-scoped state and mutations for persisted uploaded templates. */
export function createImportedPresentationTemplateSignals() {
  const cache: ImportedPresentationTemplateCache = {
    previewAssetIdsByTemplateId: new Map(),
    previewUrlByAssetId: new Map(),
  };
  const internalPreviewUrlsVersion$ = state(0);
  const catalog$ = createCachedImportedPresentationTemplateCatalog$(
    importedPresentationTemplateCatalog$,
    cache,
    internalPreviewUrlsVersion$,
    deletedPresentationTemplateIds$,
  );
  const internalUpdatedTemplates$ = state<
    readonly PresentationTemplateSummary[]
  >([]);
  const importedPresentationTemplates$ = createImportedPresentationTemplates$(
    catalog$,
    deletedPresentationTemplateIds$,
    internalUpdatedTemplates$,
  );
  const detailResolver =
    createImportedPresentationTemplateDetailResolver(catalog$);
  const urlRefresh = createImportedPresentationTemplateUrlRefreshSignals(
    catalog$,
    cache,
    internalPreviewUrlsVersion$,
  );
  const { internalRequestedTemplateId$, ...detailSignals } =
    createImportedPresentationTemplateDetailSignals(detailResolver.resolve);

  const internalPreviewTemplateId$ = state<string | null>(null);
  const importedPresentationTemplatePreviewId$ = computed((get) => {
    return get(internalPreviewTemplateId$);
  });
  const internalPreviewSlideIndex$ = state(0);
  const importedPresentationTemplatePreviewSlideIndex$ = computed((get) => {
    return get(internalPreviewSlideIndex$);
  });
  const openImportedPresentationTemplatePreview$ = command(
    ({ set }, templateId: string, index: number) => {
      set(internalRequestedTemplateId$, templateId);
      set(internalPreviewTemplateId$, templateId);
      set(internalPreviewSlideIndex$, index);
    },
  );
  const closeImportedPresentationTemplatePreview$ = command(({ set }) => {
    set(internalPreviewTemplateId$, null);
    set(internalPreviewSlideIndex$, 0);
  });
  const selectImportedPresentationTemplatePreviewSlide$ = command(
    ({ set }, index: number) => {
      set(internalPreviewSlideIndex$, index);
    },
  );

  const {
    internalCardHover$,
    importedPresentationTemplateCardHover$,
    setImportedPresentationTemplateCardHover$,
  } = createImportedPresentationTemplateHoverSignals();

  const updateImportedPresentationTemplate$ =
    createUpdateImportedPresentationTemplate$(internalUpdatedTemplates$);

  const deleteImportedPresentationTemplate$ = command(
    async (
      { get, set },
      templateId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      const client = get(apiClient$)(presentationTemplatesContract);
      await accept(
        client.delete({
          params: { templateId },
          fetchOptions: { signal },
        }),
        [204],
      );
      signal.throwIfAborted();
      evictImportedPresentationTemplateCache(cache, templateId);
      detailResolver.evict(templateId);
      set(internalUpdatedTemplates$, (updatedTemplates) => {
        return updatedTemplates.filter((template) => {
          return template.id !== templateId;
        });
      });
      set(deletedPresentationTemplateIds$, (deletedTemplateIds) => {
        return new Set([...deletedTemplateIds, templateId]);
      });
      set(internalPreviewTemplateId$, null);
      set(internalPreviewSlideIndex$, 0);
      set(internalRequestedTemplateId$, null);
      set(internalCardHover$, null);
      await set(refreshAndLoadPresentationTemplates$, signal);
    },
  );

  const resetImportedPresentationTemplatePicker$ = command(({ set }) => {
    set(internalPreviewTemplateId$, null);
    set(internalPreviewSlideIndex$, 0);
    set(internalRequestedTemplateId$, null);
    set(internalCardHover$, null);
  });

  return {
    importedPresentationTemplates$,
    importedPresentationTemplateDeletedIds$,
    ...detailSignals,
    ...urlRefresh,
    importedPresentationTemplatePreviewId$,
    importedPresentationTemplatePreviewSlideIndex$,
    openImportedPresentationTemplatePreview$,
    closeImportedPresentationTemplatePreview$,
    selectImportedPresentationTemplatePreviewSlide$,
    importedPresentationTemplateCardHover$,
    setImportedPresentationTemplateCardHover$,
    updateImportedPresentationTemplate$,
    deleteImportedPresentationTemplate$,
    resetImportedPresentationTemplatePicker$,
  };
}
