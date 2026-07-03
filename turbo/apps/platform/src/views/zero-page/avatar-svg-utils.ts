import { avatarSvgAssetUrl } from "./platform-assets.ts";

export const AVATAR_SVG_PREFIX = "svg:";

export interface AvatarSvgConfig {
  rotation: number; // 1-5
  skin: number; // 0-4
  hairStyle: number; // 1-5
  hairColor: number; // 1-5 (1=yellow, 2=teal, 3=grey, 4=pink, 5=brown)
  expression: number; // 1-5
  intensity: "d" | "m" | "h"; // default, medium, high
}

const AVATAR_ROTATIONS = [1, 2, 3, 4, 5] as const;
const AVATAR_SKINS = [0, 1, 2, 3, 4] as const;
const AVATAR_HAIR_STYLES = [1, 2, 3, 4, 5] as const;
const AVATAR_HAIR_COLORS = [1, 2, 3, 4, 5] as const;
const AVATAR_EXPRESSIONS = [1, 2, 3, 4, 5] as const;
const AVATAR_INTENSITIES = ["d", "m", "h"] as const;
const AVATAR_SVG_PRELOAD_BATCH_SIZE = 12;
const AVATAR_SVG_PRELOAD_IDLE_TIMEOUT_MS = 1000;
const AVATAR_SVG_PRELOAD_CACHE_KEY = "vm0AvatarSvgPreloadCache";

const INTENSITY_MAP = {
  d: "d",
  m: "m",
  h: "h",
} as const;

interface AvatarSvgPreloadCache {
  readonly preloads: Map<string, HTMLImageElement>;
  readonly scheduledUrls: Set<string>;
}

interface NavigatorConnectionLike {
  readonly saveData?: boolean;
}

interface NavigatorWithConnection extends Navigator {
  readonly connection?: NavigatorConnectionLike;
}

/**
 * Serialize an avatar config to a storable string like `svg:r1s0h3c2f1d`.
 */
export function serializeAvatarSvgConfig(config: AvatarSvgConfig): string {
  return `${AVATAR_SVG_PREFIX}r${config.rotation}s${config.skin}h${config.hairStyle}c${config.hairColor}f${config.expression}${config.intensity}`;
}

/**
 * Parse a `svg:r1s0h3c2f1d` string back into config, or return null.
 */
export function parseAvatarSvgConfig(
  value: string | null | undefined,
): AvatarSvgConfig | null {
  if (!value?.startsWith(AVATAR_SVG_PREFIX)) {
    return null;
  }
  const body = value.slice(AVATAR_SVG_PREFIX.length);
  const match = /^r([1-5])s([0-4])h([1-5])c([1-5])f([1-5])([dmh])$/.exec(body);
  if (!match) {
    return null;
  }
  const intensityKey = match[6] as keyof typeof INTENSITY_MAP;
  return {
    rotation: Number(match[1]),
    skin: Number(match[2]),
    hairStyle: Number(match[3]),
    hairColor: Number(match[4]),
    expression: Number(match[5]),
    intensity: INTENSITY_MAP[intensityKey],
  };
}

export function avatarSvgLayerUrls(config: AvatarSvgConfig): {
  head: string;
  face: string;
  hair: string;
} {
  return {
    head: avatarSvgAssetUrl(`head-r${config.rotation}-s${config.skin}.svg`),
    face: avatarSvgAssetUrl(
      `face-r${config.rotation}-f${config.expression}-${config.intensity}.svg`,
    ),
    hair: avatarSvgAssetUrl(
      `hair-r${config.rotation}-h${config.hairStyle}-c${config.hairColor}.svg`,
    ),
  };
}

export function allAvatarSvgLayerUrls(): string[] {
  const urls: string[] = [];
  for (const rotation of AVATAR_ROTATIONS) {
    for (const skin of AVATAR_SKINS) {
      urls.push(avatarSvgAssetUrl(`head-r${rotation}-s${skin}.svg`));
    }
    for (const expression of AVATAR_EXPRESSIONS) {
      for (const intensity of AVATAR_INTENSITIES) {
        urls.push(
          avatarSvgAssetUrl(
            `face-r${rotation}-f${expression}-${intensity}.svg`,
          ),
        );
      }
    }
    for (const hairStyle of AVATAR_HAIR_STYLES) {
      for (const hairColor of AVATAR_HAIR_COLORS) {
        urls.push(
          avatarSvgAssetUrl(
            `hair-r${rotation}-h${hairStyle}-c${hairColor}.svg`,
          ),
        );
      }
    }
  }
  return Array.from(new Set(urls));
}

function avatarSvgPreloadCache(): AvatarSvgPreloadCache {
  const existingCache = Reflect.get(
    globalThis,
    AVATAR_SVG_PRELOAD_CACHE_KEY,
  ) as AvatarSvgPreloadCache | undefined;
  if (existingCache !== undefined) {
    return existingCache;
  }

  const cache: AvatarSvgPreloadCache = {
    preloads: new Map<string, HTMLImageElement>(),
    scheduledUrls: new Set<string>(),
  };
  Reflect.set(globalThis, AVATAR_SVG_PRELOAD_CACHE_KEY, cache);
  return cache;
}

function prefersReducedData(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const connection = (navigator as NavigatorWithConnection).connection;
  return connection?.saveData === true;
}

function preloadAvatarSvgLayerUrl(
  url: string,
  cache: AvatarSvgPreloadCache,
): void {
  if (cache.preloads.has(url)) {
    return;
  }

  const image = new Image();
  image.decoding = "async";
  image.fetchPriority = "low";
  image.src = url;
  cache.preloads.set(url, image);
}

function scheduleAvatarSvgPreloadBatch(callback: IdleRequestCallback): void {
  if (typeof window === "undefined") {
    return;
  }
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(callback, {
      timeout: AVATAR_SVG_PRELOAD_IDLE_TIMEOUT_MS,
    });
    return;
  }

  window.setTimeout(() => {
    callback({
      didTimeout: true,
      timeRemaining: () => {
        return 0;
      },
    });
  }, 16);
}

function scheduleAvatarSvgPreloadBatches(
  urls: readonly string[],
  cache: AvatarSvgPreloadCache,
): void {
  let nextIndex = 0;

  const preloadBatch: IdleRequestCallback = (deadline) => {
    let processed = 0;
    while (
      nextIndex < urls.length &&
      processed < AVATAR_SVG_PRELOAD_BATCH_SIZE
    ) {
      if (
        !deadline.didTimeout &&
        processed > 0 &&
        deadline.timeRemaining() < 4
      ) {
        break;
      }
      preloadAvatarSvgLayerUrl(urls[nextIndex]!, cache);
      nextIndex += 1;
      processed += 1;
    }

    if (nextIndex < urls.length) {
      scheduleAvatarSvgPreloadBatch(preloadBatch);
    }
  };

  scheduleAvatarSvgPreloadBatch(preloadBatch);
}

export function preloadAvatarSvgLayerAssets(): void {
  if (
    typeof Image === "undefined" ||
    typeof window === "undefined" ||
    prefersReducedData()
  ) {
    return;
  }

  const cache = avatarSvgPreloadCache();
  const urlsToPreload = allAvatarSvgLayerUrls().filter((url) => {
    return !cache.scheduledUrls.has(url);
  });
  if (urlsToPreload.length === 0) {
    return;
  }

  for (const url of urlsToPreload) {
    cache.scheduledUrls.add(url);
  }
  scheduleAvatarSvgPreloadBatches(urlsToPreload, cache);
}

export function randomAvatarSvgConfig(): AvatarSvgConfig {
  const rand = (min: number, max: number) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  };
  return {
    rotation: rand(1, 5),
    skin: rand(0, 4),
    hairStyle: rand(1, 5),
    hairColor: rand(1, 5),
    expression: rand(1, 5),
    intensity: AVATAR_INTENSITIES[rand(0, AVATAR_INTENSITIES.length - 1)]!,
  };
}
