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
const deletedPresentationTemplateIds$ = state<ReadonlySet<string>>(new Set());
const importedPresentationTemplateDeletedIds$ = computed((get) => {
  return get(deletedPresentationTemplateIds$);
});
const PRESENTATION_TEMPLATE_PREVIEW_URL_SAFETY_MS = 45 * 1000;
const LEGACY_PRESENTATION_TEMPLATE_URL_REFRESH_AGE_MS =
  (PRESENTATION_TEMPLATE_URL_TTL_SECONDS * 1000 * 2) / 3;

interface ImportedPresentationTemplateCatalogEntry extends PresentationTemplateCatalogEntry {
  /** Present only when compatibility with an older API required a detail GET. */
  readonly pageUrls?: readonly string[];
}

interface ImportedPresentationTemplateCatalog {
  readonly templates: readonly ImportedPresentationTemplateCatalogEntry[];
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
    const templates = await Promise.all(
      result.body.map(
        async (
          template,
        ): Promise<ImportedPresentationTemplateCatalogEntry | null> => {
          if (template.previewAssets !== undefined) {
            return template;
          }
          // Remove after the previous API version can no longer serve a newly
          // loaded frontend. The fallback is background-only, so opening the
          // picker or its detail view never initiates this request.
          const detail = await accept(
            client.get({ params: { templateId: template.id } }),
            [200, 404],
          );
          return detail.status === 404
            ? null
            : {
                ...template,
                pageUrls: detail.body.pageUrls,
                previewAssets: detail.body.previewAssets,
              };
        },
      ),
    );
    return {
      templates: templates.flatMap((template) => {
        return template === null ? [] : [template];
      }),
      loadedAtMs: now(),
    };
  },
);

/** Refetch the catalog after a mutation or realtime catch-up. */
const refreshPresentationTemplates$ = command(({ get, set }) => {
  set(presentationTemplatesVersion$, get(presentationTemplatesVersion$) + 1);
});

const reconcileDeletedPresentationTemplateIds$ = command(
  ({ get, set }, templates: readonly PresentationTemplateSummary[]): void => {
    const deletedTemplateIds = get(deletedPresentationTemplateIds$);
    if (deletedTemplateIds.size === 0) {
      return;
    }
    const catalogTemplateIds = new Set(
      templates.map((template) => {
        return template.id;
      }),
    );
    const pendingDeletedTemplateIds = new Set(
      [...deletedTemplateIds].filter((templateId) => {
        return catalogTemplateIds.has(templateId);
      }),
    );
    if (pendingDeletedTemplateIds.size !== deletedTemplateIds.size) {
      set(deletedPresentationTemplateIds$, pendingDeletedTemplateIds);
    }
  },
);

const refreshAndReconcilePresentationTemplates$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    set(refreshPresentationTemplates$);
    const catalog = await get(importedPresentationTemplateCatalog$);
    signal.throwIfAborted();
    set(reconcileDeletedPresentationTemplateIds$, catalog.templates);
  },
);

const refreshPresentationTemplatesFromRealtime$ = command(
  async ({ set }, signal: AbortSignal): Promise<boolean> => {
    await set(refreshAndReconcilePresentationTemplates$, signal);
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

type CachedImportedPresentationTemplateDetail =
  | {
      readonly kind: "preview-assets";
      readonly previewAssetIds: readonly string[];
    }
  | {
      readonly kind: "legacy-page-urls";
      readonly pageUrls: readonly string[];
    };

interface ImportedPresentationTemplateCache {
  readonly detailByTemplateId: Map<
    string,
    CachedImportedPresentationTemplateDetail
  >;
  readonly previewUrlByAssetId: Map<string, PresentationTemplatePreviewAsset>;
}

export function evictImportedPresentationTemplateCache(
  cache: ImportedPresentationTemplateCache,
  templateId: string,
): void {
  const removedDetail = cache.detailByTemplateId.get(templateId);
  cache.detailByTemplateId.delete(templateId);
  if (removedDetail?.kind !== "preview-assets") {
    return;
  }
  const retainedPreviewAssetIds = new Set(
    [...cache.detailByTemplateId.values()].flatMap((detail) => {
      return detail.kind === "preview-assets" ? detail.previewAssetIds : [];
    }),
  );
  for (const previewAssetId of removedDetail.previewAssetIds) {
    if (!retainedPreviewAssetIds.has(previewAssetId)) {
      cache.previewUrlByAssetId.delete(previewAssetId);
    }
  }
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
  templates: readonly ImportedPresentationTemplateCatalogEntry[],
): readonly PresentationTemplateDetail[] {
  const templateIds = new Set(
    templates.map((template) => {
      return template.id;
    }),
  );
  for (const cachedTemplateId of cache.detailByTemplateId.keys()) {
    if (!templateIds.has(cachedTemplateId)) {
      cache.detailByTemplateId.delete(cachedTemplateId);
    }
  }
  for (const template of templates) {
    if (template.previewAssets !== undefined) {
      for (const asset of template.previewAssets) {
        mergePresentationTemplatePreviewAsset(cache, asset);
      }
      cache.detailByTemplateId.set(template.id, {
        kind: "preview-assets",
        previewAssetIds: template.previewAssets.map((asset) => {
          return asset.previewAssetId;
        }),
      });
      continue;
    }
    const cachedDetail = cache.detailByTemplateId.get(template.id);
    if (
      cachedDetail?.kind !== "preview-assets" &&
      template.pageUrls !== undefined
    ) {
      cache.detailByTemplateId.set(template.id, {
        kind: "legacy-page-urls",
        pageUrls: template.pageUrls,
      });
    }
  }
  const retainedPreviewAssetIds = new Set(
    [...cache.detailByTemplateId.values()].flatMap((detail) => {
      return detail.kind === "preview-assets" ? detail.previewAssetIds : [];
    }),
  );
  for (const previewAssetId of cache.previewUrlByAssetId.keys()) {
    if (!retainedPreviewAssetIds.has(previewAssetId)) {
      cache.previewUrlByAssetId.delete(previewAssetId);
    }
  }
  return templates.map((template) => {
    const cachedDetail = cache.detailByTemplateId.get(template.id);
    if (cachedDetail === undefined) {
      throw new Error(
        `Presentation template detail is not cached: ${template.id}`,
      );
    }
    if (cachedDetail.kind === "legacy-page-urls") {
      return {
        ...template,
        coverUrl: cachedDetail.pageUrls[0] ?? template.coverUrl,
        pageUrls: [...cachedDetail.pageUrls],
      };
    }
    const previewAssets = cachedDetail.previewAssetIds.map((previewAssetId) => {
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
) {
  return computed(
    async (get): Promise<CachedImportedPresentationTemplateCatalog> => {
      get(previewUrlsVersion$);
      const catalog = await get(catalog$);
      return {
        ...catalog,
        templates: synchronizeImportedPresentationTemplateCache(
          cache,
          catalog.templates,
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
        LEGACY_PRESENTATION_TEMPLATE_URL_REFRESH_AGE_MS -
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
      const catalog = await get(catalog$);
      signal.throwIfAborted();
      if (cache.previewUrlByAssetId.size === 0) {
        if (
          now() - catalog.loadedAtMs >=
          LEGACY_PRESENTATION_TEMPLATE_URL_REFRESH_AGE_MS
        ) {
          await set(refreshAndReconcilePresentationTemplates$, signal);
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
        await set(refreshAndReconcilePresentationTemplates$, signal);
        return;
      }
      const updated = assets
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
            const catalog = await get(catalog$);
            loopSignal.throwIfAborted();
            await delay(
              presentationTemplatePreviewRefreshDelayMs(
                cache,
                catalog.loadedAtMs,
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
    detailByTemplateId: new Map(),
    previewUrlByAssetId: new Map(),
  };
  const internalPreviewUrlsVersion$ = state(0);
  const catalog$ = createCachedImportedPresentationTemplateCatalog$(
    importedPresentationTemplateCatalog$,
    cache,
    internalPreviewUrlsVersion$,
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
      await set(refreshAndReconcilePresentationTemplates$, signal);
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
