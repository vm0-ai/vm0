import {
  IMAGE_REFERENCE_PREVIEW_URL_TTL_SECONDS,
  MAX_IMAGE_REFERENCE_PREVIEW_ASSETS,
  imageReferencesContract,
  type CreateImageReferenceBody,
  type ImageReference,
  type ImageReferencePreviewAsset,
  type ImageReferenceVisibility,
  type UpdateImageReferenceBody,
} from "@okouai/api-contracts/contracts/image-references";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { delay } from "signal-timers";

import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { authenticatedIdentity$ } from "../auth.ts";
import {
  featureSwitch$,
  initialFeatureSwitchHydration$,
} from "../external/feature-switch.ts";
import { orgMembers$, type OrgMember } from "../external/org-members.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { rootSignal$ } from "../root-signal.ts";
import {
  createDeferredPromise,
  onRef,
  setLoop,
  withCleanup,
} from "../utils.ts";
import { uploadPrivateArtifactToStorage$ } from "./file-upload.ts";

export type { ImageReference, ImageReferenceVisibility };

const IMAGE_REFERENCE_PREVIEW_URL_SAFETY_MS = 45 * 1000;
const IMAGE_REFERENCE_CATALOG_REVALIDATE_AGE_MS =
  (IMAGE_REFERENCE_PREVIEW_URL_TTL_SECONDS * 1000 * 2) / 3;

interface ImageReferenceCatalog {
  readonly references: readonly ImageReference[];
  readonly loadedAtMs: number;
}

interface ImageReferenceCreator {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly imageUrl: string;
}

type ImageReferenceImageSlot = "a" | "b";

interface ImageReferenceLoadedImage {
  readonly desiredUrl: string;
  readonly sourceUrl: string;
  readonly slot: ImageReferenceImageSlot;
}

interface ImageReferenceImageState {
  readonly active: ImageReferenceLoadedImage | null;
  readonly failed: readonly ImageReferenceLoadedImage[];
}

interface ImageReferenceImageSignals {
  readonly desiredUrl$: Computed<Promise<string | null>>;
  readonly state$: Computed<ImageReferenceImageState>;
  readonly commitLoadedImage$: Command<
    Promise<void>,
    [ImageReferenceLoadedImage, AbortSignal]
  >;
  readonly failImageLoad$: Command<
    Promise<void>,
    [ImageReferenceLoadedImage, AbortSignal]
  >;
}

interface ImageReferenceImageBuffers {
  readonly card: ImageReferenceImageSignals;
  readonly detail: ImageReferenceImageSignals;
}

export interface ImageReferencePickerItem {
  readonly reference: ImageReference;
  readonly creator: ImageReferenceCreator | null;
  readonly imageBuffers: ImageReferenceImageBuffers;
}

export interface UploadImageReferenceInput {
  readonly file: File;
  readonly title: string;
  readonly visibility: ImageReferenceVisibility;
}

export type ImageReferenceLookup = (
  referenceId: string,
) => Computed<Promise<ImageReference | null>>;

export interface ImageReferenceLibrarySignals {
  readonly enabled$: Computed<boolean>;
  readonly references$: Computed<Promise<readonly ImageReference[]>>;
  readonly ownReferences$: Computed<Promise<readonly ImageReference[]>>;
  readonly organizationReferences$: Computed<
    Promise<readonly ImageReference[]>
  >;
  readonly pickerItems$: Computed<Promise<readonly ImageReferencePickerItem[]>>;
  readonly resolve: ImageReferenceLookup;
  readonly refresh$: Command<Promise<void>, [AbortSignal]>;
  readonly create$: Command<
    Promise<ImageReference>,
    [CreateImageReferenceBody, AbortSignal]
  >;
  readonly uploadAndCreate$: Command<
    Promise<ImageReference>,
    [UploadImageReferenceInput, AbortSignal]
  >;
  readonly update$: Command<
    Promise<ImageReference | null>,
    [string, UpdateImageReferenceBody, AbortSignal]
  >;
  readonly rename$: Command<
    Promise<ImageReference>,
    [string, string, AbortSignal]
  >;
  readonly setVisibility$: Command<
    Promise<ImageReference>,
    [string, ImageReferenceVisibility, AbortSignal]
  >;
  readonly adminUnshare$: Command<Promise<void>, [string, AbortSignal]>;
  readonly delete$: Command<Promise<void>, [string, AbortSignal]>;
  readonly refreshPreviewUrlsIfExpiring$: Command<Promise<void>, [AbortSignal]>;
  readonly lifecycleRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
}

const imageReferencesVersion$ = state(0);
const imageReferencesRealtimeReady$ = computed((get) => {
  return createDeferredPromise<void>(get(rootSignal$));
});

const imageReferencesEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.ReferenceImages] === true;
});

const imageReferencesAvailable$ = computed(async (get): Promise<void> => {
  await get(initialFeatureSwitchHydration$);
  if (!get(imageReferencesEnabled$)) {
    throw new Error("Image references are unavailable");
  }
});

const imageReferenceCatalog$ = computed(
  async (get): Promise<ImageReferenceCatalog> => {
    await get(initialFeatureSwitchHydration$);
    if (!get(imageReferencesEnabled$)) {
      return { references: [], loadedAtMs: now() };
    }

    // Both invalidation scopes attach before the baseline request. This closes
    // the fetch/subscribe gap while remaining compatible with servers that
    // publish only the older user-scoped event.
    await get(imageReferencesRealtimeReady$).promise;
    get(imageReferencesVersion$);
    const client = get(apiClient$)(imageReferencesContract);
    const result = await accept(client.list(), [200]);
    return { references: result.body, loadedAtMs: now() };
  },
);

const refreshImageReferencesVersion$ = command(({ get, set }) => {
  set(imageReferencesVersion$, get(imageReferencesVersion$) + 1);
});

const refreshAndLoadImageReferences$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    set(refreshImageReferencesVersion$);
    await get(imageReferenceCatalog$);
    signal.throwIfAborted();
  },
);

const refreshImageReferencesFromRealtime$ = command(
  async ({ set }, signal: AbortSignal): Promise<boolean> => {
    await set(refreshAndLoadImageReferences$, signal);
    return false;
  },
);

/** Subscribe once for the authenticated app lifetime. */
export const subscribeImageReferencesChanged$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    await get(initialFeatureSwitchHydration$);
    signal.throwIfAborted();
    const ready = get(imageReferencesRealtimeReady$);
    if (!get(imageReferencesEnabled$)) {
      if (!ready.settled()) {
        ready.resolve();
      }
      return;
    }

    const subscribedScopes = new Set<"user" | "org">();
    const markSubscribed = (scope: "user" | "org") => {
      subscribedScopes.add(scope);
      if (subscribedScopes.size === 2 && !ready.settled()) {
        ready.resolve();
      }
    };
    await Promise.all([
      set(
        setAblyLoop$,
        {
          topic: "imageReferencesChanged",
          loopCommand$: refreshImageReferencesFromRealtime$,
          options: {
            onSubscribed: () => {
              markSubscribed("user");
            },
          },
        },
        signal,
      ),
      set(
        setAblyLoop$,
        {
          scope: "org",
          topic: "imageReferencesChanged",
          loopCommand$: refreshImageReferencesFromRealtime$,
          options: {
            runOnForegroundCatchUp: false,
            onSubscribed: () => {
              markSubscribed("org");
            },
          },
        },
        signal,
      ),
    ]);
  },
);

interface ImageReferenceCache {
  readonly previewAssetIdByReferenceId: Map<string, string>;
  readonly previewUrlByAssetId: Map<string, ImageReferencePreviewAsset>;
  readonly imageBuffersByReferenceId: Map<string, ImageReferenceImageBuffers>;
  readonly detailByReferenceId: Map<
    string,
    Computed<Promise<ImageReference | null>>
  >;
}

function clearImageReferenceCache(cache: ImageReferenceCache): void {
  cache.previewAssetIdByReferenceId.clear();
  cache.previewUrlByAssetId.clear();
  cache.imageBuffersByReferenceId.clear();
  cache.detailByReferenceId.clear();
}

function evictImageReferenceCache(
  cache: ImageReferenceCache,
  referenceId: string,
): void {
  const previewAssetId = cache.previewAssetIdByReferenceId.get(referenceId);
  cache.previewAssetIdByReferenceId.delete(referenceId);
  cache.imageBuffersByReferenceId.delete(referenceId);
  cache.detailByReferenceId.delete(referenceId);
  if (previewAssetId !== undefined) {
    cache.previewUrlByAssetId.delete(previewAssetId);
  }
}

function mergeImageReferencePreviewAsset(
  cache: ImageReferenceCache,
  asset: ImageReferencePreviewAsset,
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

function synchronizeImageReferenceCache(
  cache: ImageReferenceCache,
  references: readonly ImageReference[],
): readonly ImageReference[] {
  const referenceIds = new Set(
    references.map((reference) => {
      return reference.id;
    }),
  );
  for (const referenceId of cache.previewAssetIdByReferenceId.keys()) {
    if (!referenceIds.has(referenceId)) {
      evictImageReferenceCache(cache, referenceId);
    }
  }

  return references.map((reference) => {
    const previousAssetId = cache.previewAssetIdByReferenceId.get(reference.id);
    if (
      previousAssetId !== undefined &&
      previousAssetId !== reference.previewAsset.previewAssetId
    ) {
      cache.previewUrlByAssetId.delete(previousAssetId);
    }
    cache.previewAssetIdByReferenceId.set(
      reference.id,
      reference.previewAsset.previewAssetId,
    );
    mergeImageReferencePreviewAsset(cache, reference.previewAsset);
    return {
      ...reference,
      previewAsset:
        cache.previewUrlByAssetId.get(reference.previewAsset.previewAssetId) ??
        reference.previewAsset,
    };
  });
}

function createCachedImageReferenceCatalog$(
  cache: ImageReferenceCache,
  previewUrlsVersion$: State<number>,
  deletedReferenceIds$: State<ReadonlySet<string>>,
) {
  return computed(async (get): Promise<ImageReferenceCatalog> => {
    get(previewUrlsVersion$);
    const deletedReferenceIds = get(deletedReferenceIds$);
    const catalog = await get(imageReferenceCatalog$);
    const retained = catalog.references.filter((reference) => {
      return !deletedReferenceIds.has(reference.id);
    });
    return {
      ...catalog,
      references: synchronizeImageReferenceCache(cache, retained),
    };
  });
}

function sameLoadedImage(
  left: ImageReferenceLoadedImage | null,
  right: ImageReferenceLoadedImage,
): boolean {
  return (
    left?.desiredUrl === right.desiredUrl &&
    left.sourceUrl === right.sourceUrl &&
    left.slot === right.slot
  );
}

function createImageReferenceImageSignals(
  desiredUrl$: Computed<Promise<string | null>>,
): ImageReferenceImageSignals {
  const internalState$ = state<ImageReferenceImageState>({
    active: null,
    failed: [],
  });
  const state$ = computed((get): ImageReferenceImageState => {
    return get(internalState$);
  });
  const commitLoadedImage$ = command(
    async (
      { get, set },
      loadedImage: ImageReferenceLoadedImage,
      signal: AbortSignal,
    ): Promise<void> => {
      const currentDesiredUrl = await get(desiredUrl$);
      signal.throwIfAborted();
      if (currentDesiredUrl !== loadedImage.desiredUrl) {
        return;
      }
      const current = get(internalState$);
      if (sameLoadedImage(current.active, loadedImage)) {
        if (current.failed.length > 0) {
          set(internalState$, { active: loadedImage, failed: [] });
        }
        return;
      }
      set(internalState$, { active: loadedImage, failed: [] });
    },
  );
  const failImageLoad$ = command(
    async (
      { get, set },
      failedImage: ImageReferenceLoadedImage,
      signal: AbortSignal,
    ): Promise<void> => {
      const currentDesiredUrl = await get(desiredUrl$);
      signal.throwIfAborted();
      if (currentDesiredUrl !== failedImage.desiredUrl) {
        return;
      }
      const current = get(internalState$);
      if (
        current.failed.some((candidate) => {
          return sameLoadedImage(candidate, failedImage);
        })
      ) {
        return;
      }
      set(internalState$, {
        ...current,
        failed: [...current.failed, failedImage],
      });
    },
  );
  return { desiredUrl$, state$, commitLoadedImage$, failImageLoad$ };
}

function imageReferenceCreator(
  reference: ImageReference,
  members: readonly OrgMember[],
): ImageReferenceCreator | null {
  const member = members.find((candidate) => {
    return candidate.userId === reference.ownerUserId;
  });
  if (!member) {
    return null;
  }
  const displayName = [member.firstName, member.lastName]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join(" ");
  return {
    userId: member.userId,
    displayName: displayName || member.email,
    email: member.email,
    imageUrl: member.imageUrl,
  };
}

async function resolveImageReferencePreviewAssets(
  createClient: ApiClientFactory,
  previewAssetIds: readonly string[],
  signal: AbortSignal,
): Promise<readonly ImageReferencePreviewAsset[]> {
  const uniqueIds = [...new Set(previewAssetIds)];
  const batches: string[][] = [];
  for (
    let index = 0;
    index < uniqueIds.length;
    index += MAX_IMAGE_REFERENCE_PREVIEW_ASSETS
  ) {
    batches.push(
      uniqueIds.slice(index, index + MAX_IMAGE_REFERENCE_PREVIEW_ASSETS),
    );
  }
  const client = createClient(imageReferencesContract);
  const responses = await Promise.all(
    batches.map(async (previewAssetIdsBatch) => {
      return await accept(
        client.resolvePreviewUrls({
          body: { previewAssetIds: previewAssetIdsBatch },
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

function expiringPreviewAssetIds(
  cache: ImageReferenceCache,
  requestedAt: number,
): readonly string[] {
  return [...cache.previewUrlByAssetId.values()]
    .filter((asset) => {
      return (
        Date.parse(asset.expiresAt) - requestedAt <=
        IMAGE_REFERENCE_PREVIEW_URL_SAFETY_MS
      );
    })
    .map((asset) => {
      return asset.previewAssetId;
    });
}

function previewRefreshDelayMs(
  cache: ImageReferenceCache,
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
        IMAGE_REFERENCE_CATALOG_REVALIDATE_AGE_MS -
        requestedAt,
    );
  }
  return Math.max(
    0,
    Math.min(...expirations) -
      IMAGE_REFERENCE_PREVIEW_URL_SAFETY_MS -
      requestedAt,
  );
}

function referencedPreviewAssetIds(
  cache: ImageReferenceCache,
): ReadonlySet<string> {
  return new Set(cache.previewAssetIdByReferenceId.values());
}

function createPreviewRefreshSignals(
  catalog$: Computed<Promise<ImageReferenceCatalog>>,
  cache: ImageReferenceCache,
  previewUrlsVersion$: State<number>,
) {
  const refreshPreviewUrlsIfExpiring$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      await get(imageReferencesAvailable$);
      signal.throwIfAborted();
      if (cache.previewUrlByAssetId.size === 0) {
        const catalog = await get(catalog$);
        signal.throwIfAborted();
        if (
          now() - catalog.loadedAtMs >=
          IMAGE_REFERENCE_CATALOG_REVALIDATE_AGE_MS
        ) {
          await set(refreshAndLoadImageReferences$, signal);
        }
        return;
      }

      const previewAssetIds = expiringPreviewAssetIds(cache, now());
      if (previewAssetIds.length === 0) {
        return;
      }
      const assets = await resolveImageReferencePreviewAssets(
        get(apiClient$),
        previewAssetIds,
        signal,
      );
      signal.throwIfAborted();
      const resolvedIds = new Set(
        assets.map((asset) => {
          return asset.previewAssetId;
        }),
      );
      if (
        previewAssetIds.some((previewAssetId) => {
          return !resolvedIds.has(previewAssetId);
        })
      ) {
        await set(refreshAndLoadImageReferences$, signal);
        return;
      }
      const referencedIds = referencedPreviewAssetIds(cache);
      const updated = assets
        .filter((asset) => {
          return referencedIds.has(asset.previewAssetId);
        })
        .map((asset) => {
          return mergeImageReferencePreviewAsset(cache, asset);
        })
        .includes(true);
      if (updated) {
        set(previewUrlsVersion$, (version) => {
          return version + 1;
        });
      }
    },
  );

  const lifecycleRef$ = onRef(
    command(
      async (
        { get, set },
        _element: HTMLElement,
        signal: AbortSignal,
      ): Promise<void> => {
        await get(initialFeatureSwitchHydration$);
        signal.throwIfAborted();
        if (!get(imageReferencesEnabled$)) {
          clearImageReferenceCache(cache);
          return;
        }
        await withCleanup(
          setLoop(
            async (loopSignal) => {
              const catalogLoadedAtMs =
                cache.previewUrlByAssetId.size === 0
                  ? (await get(catalog$)).loadedAtMs
                  : now();
              loopSignal.throwIfAborted();
              await delay(previewRefreshDelayMs(cache, catalogLoadedAtMs), {
                signal: loopSignal,
              });
              await set(refreshPreviewUrlsIfExpiring$, loopSignal);
              return false;
            },
            0,
            signal,
            { retryTransientErrors: false },
          ),
          () => {
            clearImageReferenceCache(cache);
          },
        );
      },
    ),
  );
  return { refreshPreviewUrlsIfExpiring$, lifecycleRef$ };
}

function createDeleteImageReference$(
  deletedReferenceIds$: State<ReadonlySet<string>>,
  cache: ImageReferenceCache,
) {
  return command(
    async (
      { get, set },
      referenceId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      await get(imageReferencesAvailable$);
      signal.throwIfAborted();
      const client = get(apiClient$)(imageReferencesContract);
      await accept(
        client.delete({
          params: { referenceId },
          fetchOptions: { signal },
        }),
        [204],
      );
      signal.throwIfAborted();
      evictImageReferenceCache(cache, referenceId);
      set(deletedReferenceIds$, (deletedIds) => {
        return new Set([...deletedIds, referenceId]);
      });
      await set(refreshAndLoadImageReferences$, signal);
    },
  );
}

function createMutationSignals(
  deletedReferenceIds$: State<ReadonlySet<string>>,
  cache: ImageReferenceCache,
) {
  const create$ = command(
    async (
      { get, set },
      body: CreateImageReferenceBody,
      signal: AbortSignal,
    ): Promise<ImageReference> => {
      await get(imageReferencesAvailable$);
      signal.throwIfAborted();
      const client = get(apiClient$)(imageReferencesContract);
      const result = await accept(
        client.create({ body, fetchOptions: { signal } }),
        [201],
      );
      signal.throwIfAborted();
      await set(refreshAndLoadImageReferences$, signal);
      return result.body;
    },
  );

  const uploadAndCreate$ = command(
    async (
      { get, set },
      input: UploadImageReferenceInput,
      signal: AbortSignal,
    ): Promise<ImageReference> => {
      await get(imageReferencesAvailable$);
      signal.throwIfAborted();
      const uploaded = await set(
        uploadPrivateArtifactToStorage$,
        input.file,
        signal,
      );
      signal.throwIfAborted();
      return await set(
        create$,
        {
          sourceFileId: uploaded.id,
          title: input.title,
          visibility: input.visibility,
        },
        signal,
      );
    },
  );

  const update$ = command(
    async (
      { get, set },
      referenceId: string,
      body: UpdateImageReferenceBody,
      signal: AbortSignal,
    ): Promise<ImageReference | null> => {
      await get(imageReferencesAvailable$);
      signal.throwIfAborted();
      const client = get(apiClient$)(imageReferencesContract);
      const result = await accept(
        client.update({
          params: { referenceId },
          body,
          fetchOptions: { signal },
        }),
        [200, 204],
      );
      signal.throwIfAborted();
      if (result.status === 204) {
        evictImageReferenceCache(cache, referenceId);
        set(deletedReferenceIds$, (deletedIds) => {
          return new Set([...deletedIds, referenceId]);
        });
        await set(refreshAndLoadImageReferences$, signal);
        return null;
      }
      await set(refreshAndLoadImageReferences$, signal);
      return result.body;
    },
  );

  const rename$ = command(
    async (
      { set },
      referenceId: string,
      title: string,
      signal: AbortSignal,
    ): Promise<ImageReference> => {
      const reference = await set(update$, referenceId, { title }, signal);
      if (!reference) {
        throw new Error("Image reference became unavailable while renaming");
      }
      return reference;
    },
  );

  const setVisibility$ = command(
    async (
      { set },
      referenceId: string,
      visibility: ImageReferenceVisibility,
      signal: AbortSignal,
    ): Promise<ImageReference> => {
      const reference = await set(update$, referenceId, { visibility }, signal);
      if (!reference) {
        throw new Error(
          "Image reference became unavailable while changing visibility",
        );
      }
      return reference;
    },
  );

  const adminUnshare$ = command(
    async (
      { set },
      referenceId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      await set(update$, referenceId, { visibility: "private" }, signal);
    },
  );

  const delete$ = createDeleteImageReference$(deletedReferenceIds$, cache);

  return {
    create$,
    uploadAndCreate$,
    update$,
    rename$,
    setVisibility$,
    adminUnshare$,
    delete$,
  };
}

/** Composer-owned reusable image-reference catalog and mutation state. */
export function createImageReferenceLibrarySignals(): ImageReferenceLibrarySignals {
  const cache: ImageReferenceCache = {
    previewAssetIdByReferenceId: new Map(),
    previewUrlByAssetId: new Map(),
    imageBuffersByReferenceId: new Map(),
    detailByReferenceId: new Map(),
  };
  const internalPreviewUrlsVersion$ = state(0);
  const deletedReferenceIds$ = state<ReadonlySet<string>>(new Set());
  const catalog$ = createCachedImageReferenceCatalog$(
    cache,
    internalPreviewUrlsVersion$,
    deletedReferenceIds$,
  );
  const references$ = computed(async (get) => {
    return (await get(catalog$)).references;
  });
  const ownReferences$ = computed(async (get) => {
    const [references, identity] = await Promise.all([
      get(references$),
      get(authenticatedIdentity$),
    ]);
    return references.filter((reference) => {
      return reference.ownerUserId === identity.userId;
    });
  });
  const organizationReferences$ = computed(async (get) => {
    const [references, identity] = await Promise.all([
      get(references$),
      get(authenticatedIdentity$),
    ]);
    return references.filter((reference) => {
      return reference.ownerUserId !== identity.userId;
    });
  });

  const resolve: ImageReferenceLookup = (referenceId) => {
    const existing = cache.detailByReferenceId.get(referenceId);
    if (existing) {
      return existing;
    }
    const detail$ = computed(async (get): Promise<ImageReference | null> => {
      return (
        (await get(references$)).find((reference) => {
          return reference.id === referenceId;
        }) ?? null
      );
    });
    cache.detailByReferenceId.set(referenceId, detail$);
    return detail$;
  };

  const pickerItems$ = computed(
    async (get): Promise<readonly ImageReferencePickerItem[]> => {
      const references = await get(references$);
      const members = references.length > 0 ? await get(orgMembers$) : [];
      return references.map((reference) => {
        let imageBuffers = cache.imageBuffersByReferenceId.get(reference.id);
        if (!imageBuffers) {
          const desiredUrl$ = computed(async (read) => {
            return (
              (await read(resolve(reference.id)))?.previewAsset.url ?? null
            );
          });
          imageBuffers = {
            card: createImageReferenceImageSignals(desiredUrl$),
            detail: createImageReferenceImageSignals(desiredUrl$),
          };
          cache.imageBuffersByReferenceId.set(reference.id, imageBuffers);
        }
        return {
          reference,
          creator: imageReferenceCreator(reference, members),
          imageBuffers,
        };
      });
    },
  );

  const previewRefresh = createPreviewRefreshSignals(
    catalog$,
    cache,
    internalPreviewUrlsVersion$,
  );
  const mutations = createMutationSignals(deletedReferenceIds$, cache);
  const refresh$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      await get(imageReferencesAvailable$);
      signal.throwIfAborted();
      await set(refreshAndLoadImageReferences$, signal);
    },
  );

  return {
    enabled$: imageReferencesEnabled$,
    references$,
    ownReferences$,
    organizationReferences$,
    pickerItems$,
    resolve,
    refresh$,
    ...mutations,
    ...previewRefresh,
  };
}
