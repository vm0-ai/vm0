import { z } from "zod";
import {
  presentationImagesContract,
  type PresentationImageAsset,
  type PresentationImageResolveItem,
} from "@vm0/api-contracts/contracts/presentation-images";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { command } from "ccstate";

import { env } from "../../lib/env";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { safeJsonParse, settle } from "../utils";

const UNSPLASH_SEARCH_URL = "https://api.unsplash.com/search/photos";
const UNSPLASH_HOME_URL = "https://unsplash.com/";
const UNSPLASH_UTM_SOURCE = "vm0_presentation_image_resolver";
const PEXELS_SEARCH_URL = "https://api.pexels.com/v1/search";
const MAX_SEARCH_CONCURRENCY = 6;
const RESULTS_PER_QUERY = 10;

type ResolveErrorCode =
  | "NO_RESULTS"
  | "DOWNLOAD_TRACKING_FAILED"
  | "PROVIDER_ERROR";

interface ResolveError {
  readonly code: ResolveErrorCode;
  readonly message: string;
}

type UniqueResolution =
  | { readonly status: "resolved"; readonly asset: PresentationImageAsset }
  | { readonly status: "unresolved"; readonly error: ResolveError };

// A provider search bound to its configured key: given an image brief it either
// resolves an asset or reports why it could not.
type ProviderSearch = (
  item: PresentationImageResolveItem,
  signal: AbortSignal,
) => Promise<UniqueResolution>;

const unsplashPhotoSchema = z
  .object({
    urls: z
      .object({
        regular: z.url().optional(),
        small: z.url().optional(),
        raw: z.url().optional(),
      })
      .passthrough()
      .optional(),
    links: z
      .object({
        html: z.url().optional(),
        download_location: z.url().optional(),
      })
      .passthrough()
      .optional(),
    user: z
      .object({
        name: z.string().optional(),
        links: z
          .object({
            html: z.url().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    alt_description: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    color: z.string().nullable().optional(),
    blur_hash: z.string().nullable().optional(),
  })
  .passthrough();

const unsplashSearchResponseSchema = z
  .object({
    results: z.array(unsplashPhotoSchema),
  })
  .passthrough();

type UnsplashPhoto = z.infer<typeof unsplashPhotoSchema>;

const pexelsPhotoSchema = z
  .object({
    url: z.url().optional(),
    src: z
      .object({
        large: z.url().optional(),
        medium: z.url().optional(),
        original: z.url().optional(),
      })
      .passthrough()
      .optional(),
    photographer: z.string().optional(),
    photographer_url: z.url().optional(),
    alt: z.string().nullable().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    avg_color: z.string().nullable().optional(),
  })
  .passthrough();

const pexelsSearchResponseSchema = z
  .object({
    photos: z.array(pexelsPhotoSchema),
  })
  .passthrough();

type PexelsPhoto = z.infer<typeof pexelsPhotoSchema>;

const resolveBody$ = bodyResultOf(presentationImagesContract.resolve);

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function serviceUnavailable(message: string) {
  return {
    status: 503 as const,
    body: errorBody(message, "NOT_CONFIGURED"),
  };
}

function providerError(message: string): UniqueResolution {
  return {
    status: "unresolved",
    error: { code: "PROVIDER_ERROR", message },
  };
}

function noResults(query: string, providerLabel: string): UniqueResolution {
  return {
    status: "unresolved",
    error: {
      code: "NO_RESULTS",
      message: `No ${providerLabel} image matched "${query}"`,
    },
  };
}

function downloadTrackingFailed(query: string): UniqueResolution {
  return {
    status: "unresolved",
    error: {
      code: "DOWNLOAD_TRACKING_FAILED",
      message: `Unsplash download tracking failed for "${query}"`,
    },
  };
}

function withUnsplashUtm(value: string, fallback: string): string {
  const url = new URL(value || fallback);
  url.searchParams.set("utm_source", UNSPLASH_UTM_SOURCE);
  url.searchParams.set("utm_medium", "referral");
  return url.toString();
}

function searchKey(item: PresentationImageResolveItem): string {
  return `${item.query.trim().toLowerCase()}\n${item.orientation ?? ""}`;
}

function selectedUnsplashImageUrl(photo: UnsplashPhoto): string | undefined {
  return photo.urls?.regular ?? photo.urls?.small ?? photo.urls?.raw;
}

function buildUnsplashAsset(
  item: PresentationImageResolveItem,
  photo: UnsplashPhoto,
): PresentationImageAsset | null {
  const src = selectedUnsplashImageUrl(photo);
  const photographerName = photo.user?.name?.trim();
  const photographerUrl = photo.user?.links?.html;
  const sourceUrl = photo.links?.html;
  if (!src || !photographerName || !photographerUrl || !sourceUrl) {
    return null;
  }

  return {
    src,
    alt:
      photo.alt_description?.trim() ||
      photo.description?.trim() ||
      item.intent ||
      item.query,
    source: "unsplash",
    sourceName: "Unsplash",
    sourceUrl: withUnsplashUtm(sourceUrl, UNSPLASH_HOME_URL),
    unsplashUrl: withUnsplashUtm(UNSPLASH_HOME_URL, UNSPLASH_HOME_URL),
    photographerName,
    photographerUrl: withUnsplashUtm(photographerUrl, UNSPLASH_HOME_URL),
    license: "Unsplash",
    ...(photo.width ? { width: photo.width } : {}),
    ...(photo.height ? { height: photo.height } : {}),
    ...(photo.color ? { color: photo.color } : {}),
    ...(photo.blur_hash ? { blurHash: photo.blur_hash } : {}),
  };
}

async function trackUnsplashDownload(
  photo: UnsplashPhoto,
  accessKey: string,
  signal: AbortSignal,
): Promise<boolean> {
  const downloadLocation = photo.links?.download_location;
  if (!downloadLocation) {
    return false;
  }

  const responseResult = await settle(
    fetch(downloadLocation, {
      headers: {
        Authorization: `Client-ID ${accessKey}`,
        "Accept-Version": "v1",
        "User-Agent": "vm0-presentation-image-resolver/1.0",
      },
      signal,
    }),
    signal,
  );
  if (!responseResult.ok) {
    return false;
  }

  return responseResult.value.ok;
}

async function searchUnsplash(
  item: PresentationImageResolveItem,
  accessKey: string,
  signal: AbortSignal,
): Promise<UniqueResolution> {
  const url = new URL(UNSPLASH_SEARCH_URL);
  url.searchParams.set("query", item.query);
  url.searchParams.set("per_page", String(RESULTS_PER_QUERY));
  url.searchParams.set("order_by", "relevant");
  url.searchParams.set("content_filter", "high");
  if (item.orientation) {
    url.searchParams.set("orientation", item.orientation);
  }

  const responseResult = await settle(
    fetch(url, {
      headers: {
        Authorization: `Client-ID ${accessKey}`,
        "Accept-Version": "v1",
        "User-Agent": "vm0-presentation-image-resolver/1.0",
      },
      signal,
    }),
    signal,
  );
  if (!responseResult.ok) {
    return providerError(`Unsplash search failed for "${item.query}"`);
  }

  const response = responseResult.value;
  if (!response.ok) {
    return providerError(
      `Unsplash search failed with ${response.status} ${response.statusText}`,
    );
  }

  const bodyResult = await settle(response.text(), signal);
  if (!bodyResult.ok) {
    return providerError("Unsplash search returned an unreadable response");
  }

  const parsed = unsplashSearchResponseSchema.safeParse(
    safeJsonParse(bodyResult.value),
  );
  if (!parsed.success) {
    return providerError("Unsplash search returned an unexpected response");
  }

  if (parsed.data.results.length === 0) {
    return noResults(item.query, "Unsplash");
  }

  for (const photo of parsed.data.results) {
    const asset = buildUnsplashAsset(item, photo);
    if (!asset) {
      continue;
    }

    const tracked = await trackUnsplashDownload(photo, accessKey, signal);
    if (tracked) {
      return { status: "resolved", asset };
    }
  }

  return downloadTrackingFailed(item.query);
}

// Pexels uses `square` where the contract (and Unsplash) uses `squarish`.
function pexelsOrientation(
  orientation: PresentationImageResolveItem["orientation"],
): string | undefined {
  if (!orientation) {
    return undefined;
  }
  return orientation === "squarish" ? "square" : orientation;
}

function selectedPexelsImageUrl(photo: PexelsPhoto): string | undefined {
  return photo.src?.large ?? photo.src?.medium ?? photo.src?.original;
}

function buildPexelsAsset(
  item: PresentationImageResolveItem,
  photo: PexelsPhoto,
): PresentationImageAsset | null {
  const src = selectedPexelsImageUrl(photo);
  const photographerName = photo.photographer?.trim();
  const photographerUrl = photo.photographer_url;
  const sourceUrl = photo.url;
  if (!src || !photographerName || !photographerUrl || !sourceUrl) {
    return null;
  }

  return {
    src,
    alt: photo.alt?.trim() || item.intent || item.query,
    source: "pexels",
    sourceName: "Pexels",
    sourceUrl,
    // Credit link rendered by the deck templates; for Pexels this points at the
    // photo page, which satisfies the Pexels attribution guidelines.
    unsplashUrl: sourceUrl,
    photographerName,
    photographerUrl,
    license: "Pexels",
    ...(photo.width ? { width: photo.width } : {}),
    ...(photo.height ? { height: photo.height } : {}),
    ...(photo.avg_color ? { color: photo.avg_color } : {}),
  };
}

// Pexels grants free commercial use without attribution or download tracking, so
// unlike Unsplash there is no per-image download callback to make here.
async function searchPexels(
  item: PresentationImageResolveItem,
  apiKey: string,
  signal: AbortSignal,
): Promise<UniqueResolution> {
  const url = new URL(PEXELS_SEARCH_URL);
  url.searchParams.set("query", item.query);
  url.searchParams.set("per_page", String(RESULTS_PER_QUERY));
  const orientation = pexelsOrientation(item.orientation);
  if (orientation) {
    url.searchParams.set("orientation", orientation);
  }

  const responseResult = await settle(
    fetch(url, {
      headers: {
        Authorization: apiKey,
        "User-Agent": "vm0-presentation-image-resolver/1.0",
      },
      signal,
    }),
    signal,
  );
  if (!responseResult.ok) {
    return providerError(`Pexels search failed for "${item.query}"`);
  }

  const response = responseResult.value;
  if (!response.ok) {
    return providerError(
      `Pexels search failed with ${response.status} ${response.statusText}`,
    );
  }

  const bodyResult = await settle(response.text(), signal);
  if (!bodyResult.ok) {
    return providerError("Pexels search returned an unreadable response");
  }

  const parsed = pexelsSearchResponseSchema.safeParse(
    safeJsonParse(bodyResult.value),
  );
  if (!parsed.success) {
    return providerError("Pexels search returned an unexpected response");
  }

  if (parsed.data.photos.length === 0) {
    return noResults(item.query, "Pexels");
  }

  for (const photo of parsed.data.photos) {
    const asset = buildPexelsAsset(item, photo);
    if (asset) {
      return { status: "resolved", asset };
    }
  }

  return noResults(item.query, "Pexels");
}

// Build the ordered provider chain for this request. When Unsplash is preferred
// (feature switch on) it is tried first with Pexels as fallback; otherwise images
// resolve directly from Pexels. Providers without a configured key are skipped.
function buildProviderChain(
  unsplashPreferred: boolean,
): readonly ProviderSearch[] {
  const chain: ProviderSearch[] = [];
  const unsplashKey = env("UNSPLASH_ACCESS_KEY");
  const pexelsKey = env("PEXELS_API_KEY");

  if (unsplashPreferred && unsplashKey) {
    chain.push((item, signal) => {
      return searchUnsplash(item, unsplashKey, signal);
    });
  }
  if (pexelsKey) {
    chain.push((item, signal) => {
      return searchPexels(item, pexelsKey, signal);
    });
  }

  return chain;
}

async function resolveThroughChain(
  item: PresentationImageResolveItem,
  chain: readonly ProviderSearch[],
  signal: AbortSignal,
): Promise<UniqueResolution> {
  let lastResult: UniqueResolution | undefined;
  for (const search of chain) {
    const result = await search(item, signal);
    if (result.status === "resolved") {
      return result;
    }
    lastResult = result;
  }
  return (
    lastResult ?? {
      status: "unresolved",
      error: {
        code: "NO_RESULTS",
        message: `No image matched "${item.query}"`,
      },
    }
  );
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index]!);
      }
    }),
  );

  return results;
}

const resolvePresentationImagesInner$ = command(
  async ({ get }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();

    const unsplashPreferred = isFeatureEnabled(
      FeatureSwitchKey.PresentationImageUnsplashPreferred,
      { orgId: auth.orgId, userId: auth.userId, overrides },
    );
    const chain = buildProviderChain(unsplashPreferred);
    if (chain.length === 0) {
      return serviceUnavailable(
        "Presentation image resolution is not configured",
      );
    }

    const bodyResult = await get(resolveBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const uniqueItems = new Map<string, PresentationImageResolveItem>();
    for (const item of bodyResult.data.items) {
      const key = searchKey(item);
      if (!uniqueItems.has(key)) {
        uniqueItems.set(key, item);
      }
    }

    const resolvedEntries = await mapWithConcurrency(
      [...uniqueItems.entries()],
      MAX_SEARCH_CONCURRENCY,
      async ([key, item]) => {
        return [key, await resolveThroughChain(item, chain, signal)] as const;
      },
    );
    signal.throwIfAborted();

    const resolvedByKey = new Map<string, UniqueResolution>(resolvedEntries);

    return {
      status: 200 as const,
      body: {
        items: bodyResult.data.items.map((item) => {
          const result = resolvedByKey.get(searchKey(item));
          if (!result) {
            throw new Error(`Missing image resolution for ${item.path}`);
          }

          if (result.status === "resolved") {
            return {
              path: item.path,
              query: item.query,
              status: "resolved" as const,
              asset: result.asset,
            };
          }

          return {
            path: item.path,
            query: item.query,
            status: "unresolved" as const,
            error: result.error,
          };
        }),
      },
    };
  },
);

export const presentationImagesRoutes: readonly RouteEntry[] = [
  {
    route: presentationImagesContract.resolve,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      resolvePresentationImagesInner$,
    ),
  },
];
