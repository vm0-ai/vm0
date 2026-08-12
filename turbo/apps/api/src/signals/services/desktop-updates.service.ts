import {
  DESKTOP_UPDATE_LINE_LEGACY_OKOU,
  DESKTOP_UPDATE_LINE_OKOU,
  DESKTOP_UPDATE_LINE_ZERO,
  type DesktopUpdateArchitecture,
  type DesktopUpdateChannel,
  type DesktopUpdateLine,
  type DesktopUpdatePlatform,
  type SquirrelMacReleases,
} from "@vm0/api-contracts/contracts/desktop-updates";
import {
  DESKTOP_PRODUCTS,
  DESKTOP_PRODUCT_OKOU,
  DESKTOP_PRODUCT_ZERO,
  type DesktopProduct,
} from "@vm0/api-contracts/contracts/client-headers";
import { z } from "zod";

import { testOverride } from "../../lib/singleton";
import { now } from "../../lib/time";

const DESKTOP_RELEASE_DOWNLOAD_URL_PREFIX =
  "https://github.com/vm0-ai/vm0/releases/download";
const DESKTOP_RELEASE_PAGE_URL_PREFIX =
  "https://github.com/vm0-ai/vm0/releases/tag";
const MIN_DESKTOP_DMG_VERSION = "0.12.0";

const DESKTOP_UPDATE_MANIFEST_CACHE_TTL_MS = 60_000;

function desktopUpdateManifestUrl(line: DesktopUpdateLine): string {
  if (line === DESKTOP_UPDATE_LINE_ZERO) {
    return "https://github.com/vm0-ai/vm0/releases/download/desktop-updates/desktop-update-manifest.json";
  }
  if (line === DESKTOP_UPDATE_LINE_LEGACY_OKOU) {
    return "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-updates/okou-desktop-update-manifest.json";
  }
  if (line === DESKTOP_UPDATE_LINE_OKOU) {
    return "https://github.com/vm0-ai/vm0/releases/download/ai-okou-desktop-updates/ai-okou-desktop-update-manifest.json";
  }
  return line satisfies never;
}

function desktopProductForUpdateLine(line: DesktopUpdateLine): DesktopProduct {
  return line === DESKTOP_UPDATE_LINE_ZERO
    ? DESKTOP_PRODUCT_ZERO
    : DESKTOP_PRODUCT_OKOU;
}

function desktopProductArtifactName(product: DesktopProduct): string {
  return product === DESKTOP_PRODUCT_OKOU ? "Okou" : "Zero";
}

function desktopProductReleaseTagPrefix(product: DesktopProduct): string {
  return product === DESKTOP_PRODUCT_OKOU ? "okou-desktop-v" : "desktop-v";
}

const desktopUpdateAssetSchema = z.object({
  url: z.string().url(),
});

const desktopUpdateReleaseSchema = z.object({
  version: z.string().min(1),
  name: z.string().optional(),
  notes: z.string().optional(),
  pubDate: z.string().datetime(),
  platforms: z.record(
    z.string(),
    z.record(z.string(), desktopUpdateAssetSchema),
  ),
});

const desktopUpdateChannelSchema = z.object({
  latest: z.string().min(1),
  blocked: z.array(z.string().min(1)).optional(),
});

const desktopUpdateManifestSchema = z.object({
  schemaVersion: z.literal(1),
  product: z.enum(DESKTOP_PRODUCTS).optional(),
  channels: z.record(z.string(), desktopUpdateChannelSchema),
  releases: z.record(z.string(), desktopUpdateReleaseSchema),
});

type DesktopUpdateManifest = z.infer<typeof desktopUpdateManifestSchema>;

interface DesktopUpdateFeedRequest {
  readonly line: DesktopUpdateLine;
  readonly channel: DesktopUpdateChannel;
  readonly platform: DesktopUpdatePlatform;
  readonly arch: DesktopUpdateArchitecture;
}

interface DesktopUpdateManifestCacheEntry {
  readonly expiresAt: number;
  readonly manifest: DesktopUpdateManifest;
}

const desktopUpdateManifestCache = testOverride<
  Partial<Record<DesktopUpdateLine, DesktopUpdateManifestCacheEntry>>
>(() => {
  return {};
});

const desktopUpdateManifestOverride = testOverride<
  Partial<Record<DesktopUpdateLine, DesktopUpdateManifest>>
>(() => {
  return {};
});

export function clearDesktopUpdateManifestCacheForTest(): void {
  desktopUpdateManifestCache.clear();
  desktopUpdateManifestOverride.clear();
}

function compareDesktopVersions(left: string, right: string): number {
  const leftParts = left.split(/[+-]/, 1)[0]?.split(".").map(Number) ?? [];
  const rightParts = right.split(/[+-]/, 1)[0]?.split(".").map(Number) ?? [];

  for (let index = 0; index < 3; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return left.localeCompare(right);
}

function compareDesktopVersionsDesc(left: string, right: string): number {
  return compareDesktopVersions(right, left);
}

function assetForRelease(
  release: DesktopUpdateManifest["releases"][string],
  request: DesktopUpdateFeedRequest,
): { readonly url: string } | null {
  const asset = release.platforms[request.platform]?.[request.arch];
  if (!asset) {
    return null;
  }

  const product = desktopProductForUpdateLine(request.line);
  const expectedAssetName = `${desktopProductArtifactName(product)}-${request.platform}-${request.arch}-${release.version}.zip`;
  const actualAssetName = decodeURIComponent(
    new URL(asset.url).pathname.split("/").at(-1) ?? "",
  );
  return actualAssetName === expectedAssetName ? asset : null;
}

function squirrelRelease(
  release: DesktopUpdateManifest["releases"][string],
  asset: { readonly url: string },
  product: DesktopProduct,
) {
  return {
    version: release.version,
    updateTo: {
      name:
        release.name ??
        `${desktopProductArtifactName(product)} ${release.version}`,
      version: release.version,
      pub_date: release.pubDate,
      url: asset.url,
      notes: release.notes ?? "",
    },
  };
}

function desktopReleasePageUrl(
  release: DesktopUpdateManifest["releases"][string],
  product: DesktopProduct,
): string {
  const tagName = `${desktopProductReleaseTagPrefix(product)}${release.version}`;
  return `${DESKTOP_RELEASE_PAGE_URL_PREFIX}/${encodeURIComponent(tagName)}`;
}

function desktopDmgDownloadUrl(
  release: DesktopUpdateManifest["releases"][string],
  request: DesktopUpdateFeedRequest,
): string {
  const product = desktopProductForUpdateLine(request.line);
  const tagName = `${desktopProductReleaseTagPrefix(product)}${release.version}`;
  const assetName = `${desktopProductArtifactName(product)}-${request.platform}-${request.arch}-${release.version}.dmg`;
  return `${DESKTOP_RELEASE_DOWNLOAD_URL_PREFIX}/${encodeURIComponent(
    tagName,
  )}/${encodeURIComponent(assetName)}`;
}

function selectDesktopRelease(
  manifest: DesktopUpdateManifest,
  request: DesktopUpdateFeedRequest,
) {
  const channel = manifest.channels[request.channel];
  if (!channel) {
    return null;
  }

  const blocked = new Set(channel.blocked ?? []);
  const latest = manifest.releases[channel.latest];
  if (latest && !blocked.has(latest.version)) {
    const latestAsset = assetForRelease(latest, request);
    if (latestAsset) {
      return { release: latest, asset: latestAsset };
    }
  }

  const [fallback] = Object.values(manifest.releases)
    .filter((release) => {
      return (
        !blocked.has(release.version) &&
        compareDesktopVersions(release.version, channel.latest) <= 0 &&
        assetForRelease(release, request)
      );
    })
    .sort((left, right) => {
      return compareDesktopVersionsDesc(left.version, right.version);
    });
  if (!fallback) {
    return null;
  }

  const asset = assetForRelease(fallback, request);
  if (!asset) {
    return null;
  }

  return { release: fallback, asset };
}

function buildDesktopUpdateFeed(
  manifest: DesktopUpdateManifest,
  request: DesktopUpdateFeedRequest,
): SquirrelMacReleases | null {
  const selected = selectDesktopRelease(manifest, request);
  if (!selected) {
    return null;
  }

  return {
    currentRelease: selected.release.version,
    releases: [
      squirrelRelease(
        selected.release,
        selected.asset,
        desktopProductForUpdateLine(request.line),
      ),
    ],
  };
}

async function fetchDesktopUpdateManifest(
  line: DesktopUpdateLine,
  signal: AbortSignal,
): Promise<DesktopUpdateManifest> {
  const override = desktopUpdateManifestOverride.get()[line];
  if (override) {
    return override;
  }

  const response = await fetch(desktopUpdateManifestUrl(line), {
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Desktop update manifest fetch failed with ${response.status}`,
    );
  }

  const manifest = desktopUpdateManifestSchema.parse(await response.json());
  const manifestProduct = manifest.product ?? DESKTOP_PRODUCT_ZERO;
  const expectedProduct = desktopProductForUpdateLine(line);
  if (manifestProduct !== expectedProduct) {
    throw new Error(
      `Desktop update manifest product mismatch: expected ${expectedProduct}, received ${manifestProduct}`,
    );
  }
  return manifest;
}

async function loadDesktopUpdateManifest(
  line: DesktopUpdateLine,
  signal: AbortSignal,
): Promise<DesktopUpdateManifest> {
  const cache = desktopUpdateManifestCache.get();
  const cacheEntry = cache[line];
  const nowMs = now();
  if (cacheEntry && cacheEntry.expiresAt > nowMs) {
    return cacheEntry.manifest;
  }

  const manifest = await fetchDesktopUpdateManifest(line, signal);
  desktopUpdateManifestCache.set({
    ...cache,
    [line]: {
      expiresAt: nowMs + DESKTOP_UPDATE_MANIFEST_CACHE_TTL_MS,
      manifest,
    },
  });
  return manifest;
}

export async function loadDesktopUpdateFeed(
  request: DesktopUpdateFeedRequest,
  signal: AbortSignal,
): Promise<SquirrelMacReleases | null> {
  const manifest = await loadDesktopUpdateManifest(request.line, signal);
  return buildDesktopUpdateFeed(manifest, request);
}

export async function loadDesktopReleasePageUrl(
  request: DesktopUpdateFeedRequest,
  signal: AbortSignal,
): Promise<string | null> {
  const manifest = await loadDesktopUpdateManifest(request.line, signal);
  const selected = selectDesktopRelease(manifest, request);
  return selected
    ? desktopReleasePageUrl(
        selected.release,
        desktopProductForUpdateLine(request.line),
      )
    : null;
}

export async function loadDesktopDmgDownloadUrl(
  request: DesktopUpdateFeedRequest,
  signal: AbortSignal,
): Promise<string | null> {
  const manifest = await loadDesktopUpdateManifest(request.line, signal);
  const selected = selectDesktopRelease(manifest, request);
  if (
    !selected ||
    compareDesktopVersions(selected.release.version, MIN_DESKTOP_DMG_VERSION) <
      0
  ) {
    return null;
  }
  return desktopDmgDownloadUrl(selected.release, request);
}
