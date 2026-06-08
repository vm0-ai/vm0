import type {
  DesktopUpdateArchitecture,
  DesktopUpdateChannel,
  DesktopUpdatePlatform,
  SquirrelMacReleases,
} from "@vm0/api-contracts/contracts/desktop-updates";
import { z } from "zod";

import { testOverride } from "../../lib/singleton";
import { now } from "../../lib/time";

const DESKTOP_UPDATE_MANIFEST_URL =
  "https://github.com/vm0-ai/vm0/releases/download/desktop-updates/desktop-update-manifest.json";

const DESKTOP_UPDATE_MANIFEST_CACHE_TTL_MS = 60_000;

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
  channels: z.record(z.string(), desktopUpdateChannelSchema),
  releases: z.record(z.string(), desktopUpdateReleaseSchema),
});

export type DesktopUpdateManifest = z.infer<typeof desktopUpdateManifestSchema>;

interface DesktopUpdateFeedRequest {
  readonly channel: DesktopUpdateChannel;
  readonly platform: DesktopUpdatePlatform;
  readonly arch: DesktopUpdateArchitecture;
}

interface DesktopUpdateManifestCacheEntry {
  readonly expiresAt: number;
  readonly manifest: DesktopUpdateManifest;
}

const desktopUpdateManifestCache =
  testOverride<DesktopUpdateManifestCacheEntry | null>(() => {
    return null;
  });

const desktopUpdateManifestOverride = testOverride<
  DesktopUpdateManifest | undefined
>(() => {
  return undefined;
});

export function clearDesktopUpdateManifestCacheForTest(): void {
  desktopUpdateManifestCache.clear();
  desktopUpdateManifestOverride.clear();
}

export function mockDesktopUpdateManifestForTest(
  manifest: DesktopUpdateManifest,
): void {
  desktopUpdateManifestCache.clear();
  desktopUpdateManifestOverride.set(manifest);
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
  return release.platforms[request.platform]?.[request.arch] ?? null;
}

function squirrelRelease(
  release: DesktopUpdateManifest["releases"][string],
  asset: { readonly url: string },
) {
  return {
    version: release.version,
    updateTo: {
      name: release.name ?? `Zero ${release.version}`,
      version: release.version,
      pub_date: release.pubDate,
      url: asset.url,
      notes: release.notes ?? "",
    },
  };
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
    releases: [squirrelRelease(selected.release, selected.asset)],
  };
}

async function fetchDesktopUpdateManifest(
  signal: AbortSignal,
): Promise<DesktopUpdateManifest> {
  const override = desktopUpdateManifestOverride.get();
  if (override) {
    return override;
  }

  const response = await fetch(DESKTOP_UPDATE_MANIFEST_URL, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Desktop update manifest fetch failed with ${response.status}`,
    );
  }

  return desktopUpdateManifestSchema.parse(await response.json());
}

async function loadDesktopUpdateManifest(
  signal: AbortSignal,
): Promise<DesktopUpdateManifest> {
  const cacheEntry = desktopUpdateManifestCache.get();
  const nowMs = now();
  if (cacheEntry && cacheEntry.expiresAt > nowMs) {
    return cacheEntry.manifest;
  }

  const manifest = await fetchDesktopUpdateManifest(signal);
  desktopUpdateManifestCache.set({
    expiresAt: nowMs + DESKTOP_UPDATE_MANIFEST_CACHE_TTL_MS,
    manifest,
  });
  return manifest;
}

export async function loadDesktopUpdateFeed(
  request: DesktopUpdateFeedRequest,
  signal: AbortSignal,
): Promise<SquirrelMacReleases | null> {
  const manifest = await loadDesktopUpdateManifest(signal);
  return buildDesktopUpdateFeed(manifest, request);
}
