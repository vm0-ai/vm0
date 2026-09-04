import {
  avatarComposerUrl,
  parseAvatarComposerUrl,
  randomAvatarComposerConfig,
  type AvatarComposerConfig,
} from "@okouai/core/agent-avatar";
import {
  avatarComposerAssetUrl,
  avatarSvgAssetUrl,
} from "./platform-assets.ts";

export const AVATAR_SVG_PREFIX = "svg:";

export type AvatarSvgConfig = AvatarComposerConfig;

export interface LegacyAvatarSvgConfig {
  rotation: number;
  skin: number;
  hairStyle: number;
  hairColor: number;
  expression: number;
  intensity: "d" | "m" | "h";
}

export type ResolvedAvatarSvgConfig = AvatarSvgConfig | LegacyAvatarSvgConfig;

export function serializeAvatarSvgConfig(
  config: ResolvedAvatarSvgConfig,
): string {
  if (isLegacyAvatarSvgConfig(config)) {
    return `${AVATAR_SVG_PREFIX}r${config.rotation}s${config.skin}h${config.hairStyle}c${config.hairColor}f${config.expression}${config.intensity}`;
  }
  return avatarComposerUrl(config);
}

function legacyAvatarIntensity(value: string | undefined): "d" | "m" | "h" {
  if (value === "d" || value === "m" || value === "h") {
    return value;
  }
  throw new Error("Invalid legacy avatar intensity");
}

function parseLegacyAvatarSvgConfig(
  value: string | null | undefined,
): LegacyAvatarSvgConfig | null {
  if (!value?.startsWith(AVATAR_SVG_PREFIX)) {
    return null;
  }
  const body = value.slice(AVATAR_SVG_PREFIX.length);
  const match = /^r([1-5])s([0-4])h([1-5])c([1-5])f([1-5])([dmh])$/.exec(body);
  if (!match) {
    return null;
  }
  return {
    rotation: Number(match[1]),
    skin: Number(match[2]),
    hairStyle: Number(match[3]),
    hairColor: Number(match[4]),
    expression: Number(match[5]),
    intensity: legacyAvatarIntensity(match[6]),
  };
}

export function parseAvatarSvgConfig(
  value: string | null | undefined,
): ResolvedAvatarSvgConfig | null {
  return parseAvatarComposerUrl(value) ?? parseLegacyAvatarSvgConfig(value);
}

export function isLegacyAvatarSvgConfig(
  config: ResolvedAvatarSvgConfig,
): config is LegacyAvatarSvgConfig {
  return "rotation" in config;
}

export function avatarSvgLayerUrls(
  config: ResolvedAvatarSvgConfig,
): readonly string[] {
  if (isLegacyAvatarSvgConfig(config)) {
    return [
      avatarSvgAssetUrl(`head-r${config.rotation}-s${config.skin}.svg`),
      avatarSvgAssetUrl(
        `face-r${config.rotation}-f${config.expression}-${config.intensity}.svg`,
      ),
      avatarSvgAssetUrl(
        `hair-r${config.rotation}-h${config.hairStyle}-c${config.hairColor}.svg`,
      ),
    ];
  }

  const hairBase = `hairs/${config.face}/${config.hair}-${config.hairColor}`;
  const expressionSkin = config.expression === "calm" ? `-${config.skin}` : "";
  return [
    avatarComposerAssetUrl(`${hairBase}-rear.svg`),
    avatarComposerAssetUrl(`faces/${config.face}-${config.skin}.svg`),
    avatarComposerAssetUrl(`${hairBase}-front.svg`),
    avatarComposerAssetUrl(
      `expressions/${config.expression}-${config.face}${expressionSkin}.svg`,
    ),
  ];
}

export function randomAvatarSvgConfig(): AvatarSvgConfig {
  return randomAvatarComposerConfig();
}

export function randomLegacyAvatarSvgConfig(): LegacyAvatarSvgConfig {
  const randomInteger = (min: number, max: number) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  };
  const intensities = ["d", "m", "h"] as const;
  return {
    rotation: randomInteger(1, 5),
    skin: randomInteger(0, 4),
    hairStyle: randomInteger(1, 5),
    hairColor: randomInteger(1, 5),
    expression: randomInteger(1, 5),
    intensity: intensities[randomInteger(0, intensities.length - 1)]!,
  };
}
