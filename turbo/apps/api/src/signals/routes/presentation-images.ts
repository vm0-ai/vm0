import { z } from "zod";
import {
  presentationImagesContract,
  type PresentationImageAsset,
  type PresentationImageResolveItem,
} from "@vm0/api-contracts/contracts/presentation-images";
import { command } from "ccstate";

import { env } from "../../lib/env";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";

const UNSPLASH_SEARCH_URL = "https://api.unsplash.com/search/photos";
const UNSPLASH_HOME_URL = "https://unsplash.com/";
const UNSPLASH_UTM_SOURCE = "vm0_presentation_image_resolver";
const MAX_UNSPLASH_CONCURRENCY = 6;
const UNSPLASH_RESULTS_PER_QUERY = 10;

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

function noResults(query: string): UniqueResolution {
  return {
    status: "unresolved",
    error: {
      code: "NO_RESULTS",
      message: `No Unsplash image matched "${query}"`,
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

function selectedImageUrl(photo: UnsplashPhoto): string | undefined {
  return photo.urls?.regular ?? photo.urls?.small ?? photo.urls?.raw;
}

function buildAsset(
  item: PresentationImageResolveItem,
  photo: UnsplashPhoto,
): PresentationImageAsset | null {
  const src = selectedImageUrl(photo);
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

  const response = await fetch(downloadLocation, {
    headers: {
      Authorization: `Client-ID ${accessKey}`,
      "Accept-Version": "v1",
      "User-Agent": "vm0-presentation-image-resolver/1.0",
    },
    signal,
  });

  return response.ok;
}

async function searchUnsplash(
  item: PresentationImageResolveItem,
  accessKey: string,
  signal: AbortSignal,
): Promise<UniqueResolution> {
  const url = new URL(UNSPLASH_SEARCH_URL);
  url.searchParams.set("query", item.query);
  url.searchParams.set("per_page", String(UNSPLASH_RESULTS_PER_QUERY));
  url.searchParams.set("order_by", "relevant");
  url.searchParams.set("content_filter", "high");
  if (item.orientation) {
    url.searchParams.set("orientation", item.orientation);
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Client-ID ${accessKey}`,
      "Accept-Version": "v1",
      "User-Agent": "vm0-presentation-image-resolver/1.0",
    },
    signal,
  });

  if (!response.ok) {
    return providerError(
      `Unsplash search failed with ${response.status} ${response.statusText}`,
    );
  }

  const parsed = unsplashSearchResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    return providerError("Unsplash search returned an unexpected response");
  }

  if (parsed.data.results.length === 0) {
    return noResults(item.query);
  }

  for (const photo of parsed.data.results) {
    const asset = buildAsset(item, photo);
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
    const accessKey = env("UNSPLASH_ACCESS_KEY");
    if (!accessKey) {
      return serviceUnavailable("Unsplash image resolution is not configured");
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
      MAX_UNSPLASH_CONCURRENCY,
      async ([key, item]) => {
        return [key, await searchUnsplash(item, accessKey, signal)] as const;
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
            throw new Error(`Missing Unsplash resolution for ${item.path}`);
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
