import {
  avatarComposerUrl,
  parseAvatarComposerUrl,
  randomAvatarComposerConfig,
  type AvatarComposerConfig,
  type AvatarComposerFaceShape,
  type AvatarComposerHairStyle,
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

/**
 * Where each face asset puts its chin inside the 380px composer canvas. Every
 * face starts at y=116, but they end anywhere between 307 (`wide`) and 353
 * (`tall`), because the assets are normalized on width rather than height.
 */
const AVATAR_FACE_CHIN_Y: Readonly<Record<AvatarComposerFaceShape, number>> = {
  round: 314,
  square: 334,
  "round-angled-ears": 318,
  tall: 353,
  wide: 307,
  oval: 334,
};

const AVATAR_FACE_TOP_Y = 116;

/**
 * The chin of the Okou brand avatar rescaled onto the 380px canvas. The neck
 * and sweater are one shared pair of shapes, so they only fit in one place;
 * head layers are scaled about the top of the face until every chin reaches
 * this line and the same collar sits under all of them.
 */
const AVATAR_CHIN_BASELINE_Y = 327.6;

/** The face pivot (190, 116) of the 380px canvas, as a CSS transform origin. */
export const AVATAR_HEAD_TRANSFORM_ORIGIN = "50% 30.5263%";

/**
 * Visible hair tops, including strokes, on the 380px composer canvas. Square
 * faces use separate hair geometry. Center the artwork rather than its
 * transparent canvas when displaying it inside a picker option.
 */
const AVATAR_HAIR_TOP_Y: Readonly<
  Record<AvatarComposerHairStyle, readonly [regular: number, square: number]>
> = {
  "high-bun": [22, 3],
  "geometric-long": [116, 81],
  "center-part": [114, 116],
  "curly-cap": [74, 92],
  "long-center-part": [116, 116],
  sparse: [99, 96],
  "triple-bun": [43, 68],
  "rounded-crop": [116, 116],
  halo: [85, 116],
  "topknot-locks": [17, 56],
  "low-pigtails": [116, 116],
  "ribbon-updo": [45, 51],
};

function composerContentOffsetY(
  config: AvatarSvgConfig,
  headScale: number,
  neckSweater: boolean,
): number {
  const hairTop =
    AVATAR_HAIR_TOP_Y[config.hair][config.face === "square" ? 1 : 0];
  const hairBottom =
    config.hair === "low-pigtails"
      ? config.face === "square"
        ? 370
        : 348
      : config.hair === "geometric-long" || config.hair === "long-center-part"
        ? 316
        : AVATAR_FACE_CHIN_Y[config.face];
  const top = Math.max(
    0,
    AVATAR_FACE_TOP_Y + (hairTop - AVATAR_FACE_TOP_Y) * headScale,
  );
  const bottom = neckSweater
    ? 380
    : Math.min(380, Math.max(AVATAR_FACE_CHIN_Y[config.face], hairBottom));
  return ((380 - top - bottom) / 2 / 380) * 100;
}

interface AvatarSvgComposition {
  /** Drawn behind the head, and never scaled with it. */
  readonly behind: readonly string[];
  /** Head layers, scaled about `AVATAR_HEAD_TRANSFORM_ORIGIN`. */
  readonly head: readonly string[];
  /** Drawn in front of the head, and never scaled with it. */
  readonly front: readonly string[];
  readonly headScale: number;
  /** Percentage translation that centers the visible artwork vertically. */
  readonly contentOffsetY: number;
}

/**
 * `neckSweater` is the `avatarNeckSweater` switch. With it off the result is
 * byte-for-byte the four head layers at their original scale, because the neck
 * and the chin baseline are one change: a scaled head with no collar under it
 * is just a smaller or larger avatar than the one already saved.
 */
export function avatarSvgComposition(
  config: ResolvedAvatarSvgConfig,
  { neckSweater }: { readonly neckSweater: boolean },
): AvatarSvgComposition {
  if (isLegacyAvatarSvgConfig(config)) {
    return {
      behind: [],
      head: [
        avatarSvgAssetUrl(`head-r${config.rotation}-s${config.skin}.svg`),
        avatarSvgAssetUrl(
          `face-r${config.rotation}-f${config.expression}-${config.intensity}.svg`,
        ),
        avatarSvgAssetUrl(
          `hair-r${config.rotation}-h${config.hairStyle}-c${config.hairColor}.svg`,
        ),
      ],
      front: [],
      headScale: 1,
      contentOffsetY: 0,
    };
  }

  const hairBase = `hairs/${config.face}/${config.hair}-${config.hairColor}`;
  const expressionSkin = config.expression === "calm" ? `-${config.skin}` : "";
  const head = [
    avatarComposerAssetUrl(`${hairBase}-rear.svg`),
    avatarComposerAssetUrl(`faces/${config.face}-${config.skin}.svg`),
    avatarComposerAssetUrl(`${hairBase}-front.svg`),
    avatarComposerAssetUrl(
      `expressions/${config.expression}-${config.face}${expressionSkin}.svg`,
    ),
  ];
  if (!neckSweater) {
    return {
      behind: [],
      head,
      front: [],
      headScale: 1,
      contentOffsetY: composerContentOffsetY(config, 1, false),
    };
  }
  const headScale =
    (AVATAR_CHIN_BASELINE_Y - AVATAR_FACE_TOP_Y) /
    (AVATAR_FACE_CHIN_Y[config.face] - AVATAR_FACE_TOP_Y);
  return {
    behind: [avatarComposerAssetUrl(`neck/${config.skin}.svg`)],
    head,
    front: [avatarComposerAssetUrl(`sweater/${config.sweater}.svg`)],
    headScale,
    contentOffsetY: composerContentOffsetY(config, headScale, true),
  };
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
