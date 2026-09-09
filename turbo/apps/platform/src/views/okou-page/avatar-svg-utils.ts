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

export function serializeAvatarSvgConfig(config: AvatarSvgConfig): string {
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

/**
 * The chin of the Okou brand avatar rescaled onto the 380px canvas. The neck
 * and sweater are one shared pair of shapes, so they only fit in one place;
 * head layers are moved down or up until every chin reaches this line and the
 * same collar sits under all of them.
 *
 * Moved rather than scaled. The face assets are normalized on width — every one
 * of them spans the same 270px — so scaling a head to reach this line also made
 * it up to 1.24x wider or narrower than its neighbours, while the neck and the
 * collar under it never change size. That is what made one avatar's body look
 * too big for its head and the next one's too small. A translation reaches the
 * same line and leaves the drawn width alone.
 */
const AVATAR_CHIN_BASELINE_Y = 327.6;

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

/**
 * The share of the avatar box the framing rule aims the visible artwork at.
 * Read off the brand avatar, which is drawn edge to edge on its own canvas and
 * is the reference every other avatar sits next to.
 */
const AVATAR_CONTENT_TARGET_FILL = 0.92;

/** Top and bottom of the visible artwork, in 380px canvas units. */
interface AvatarContentBounds {
  readonly top: number;
  readonly bottom: number;
}

function composerContentBounds(
  config: AvatarSvgConfig,
  headOffsetY: number,
  neckSweater: boolean,
): AvatarContentBounds {
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
  return {
    // Not clamped to the canvas. A face whose chin sits below the baseline
    // moves up, and tall hair then reaches past the top of its own canvas; the
    // framing rule has to see that overhang to fit and center the artwork
    // rather than let the box crop it.
    top: hairTop + headOffsetY,
    // No offset here. Without the collar there is nothing for a chin to meet,
    // so the head is never moved and this bound is only ever asked for at the
    // drawn position.
    bottom: neckSweater
      ? 380
      : Math.min(380, Math.max(AVATAR_FACE_CHIN_Y[config.face], hairBottom)),
  };
}

function contentOffsetY({ top, bottom }: AvatarContentBounds): number {
  return ((380 - top - bottom) / 2 / 380) * 100;
}

/**
 * Half of the correction toward `AVATAR_CONTENT_TARGET_FILL`, in log space.
 *
 * Hair volume is the only thing that varies here — the chin baseline already
 * pins every face to the same box — so scaling the artwork all the way to one
 * fill would trade an uneven silhouette for an uneven face: a `rounded-crop`
 * avatar would be inflated 1.32x and end up with a larger face than the rest of
 * the cast. Moving each avatar halfway keeps every scale within 1.15x and 0.97x
 * while pulling the silhouettes from a 1.42x spread down to 1.19x.
 */
function contentScale({ top, bottom }: AvatarContentBounds): number {
  return Math.sqrt(AVATAR_CONTENT_TARGET_FILL / ((bottom - top) / 380));
}

interface AvatarSvgComposition {
  /** Drawn behind the head, and never moved with it. */
  readonly behind: readonly string[];
  /** Head layers, moved together so the chin meets the collar. */
  readonly head: readonly string[];
  /** Drawn in front of the head, and never moved with it. */
  readonly front: readonly string[];
  /** Percentage translation that lands the chin on the shared baseline. */
  readonly headOffsetY: number;
  /** Percentage translation that centers the visible artwork vertically. */
  readonly contentOffsetY: number;
  /** Scale applied to the whole artwork, about the center of its box. */
  readonly contentScale: number;
}

/**
 * The element every avatar surface places its framed artwork on. The framing is
 * a transform with no page-observable result under jsdom, so this is the slot
 * tests read it from; both the React preview and the mention-chip node view
 * expose it so they cannot drift apart.
 */
export const AVATAR_ARTWORK_SLOT = { "data-avatar-artwork": "" } as const;

/**
 * The element carrying the chin-baseline placement, inside the artwork slot.
 * Same reason as `AVATAR_ARTWORK_SLOT`: the placement is a transform with no
 * page-observable result under jsdom, and a test should not have to know which
 * element of the layer stack holds it.
 */
export const AVATAR_HEAD_SLOT = { "data-avatar-head": "" } as const;

/**
 * The artwork transform for a composition, or null when it is the identity.
 *
 * Order matters: the translation is written to the right of the scale so it
 * applies first, which carries the centering offset through the scale instead
 * of sliding an already-scaled artwork by an unscaled distance.
 */
export function avatarSvgContentTransform(placement: {
  readonly contentOffsetY: number;
  readonly contentScale: number;
}): string | null {
  const parts: string[] = [];
  if (placement.contentScale !== 1) {
    parts.push(`scale(${placement.contentScale})`);
  }
  if (placement.contentOffsetY !== 0) {
    parts.push(`translateY(${placement.contentOffsetY}%)`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * `neckSweater` is the `avatarNeckSweater` switch. With it off the result is
 * byte-for-byte the four head layers where they were drawn, because the neck
 * and the chin baseline are one change: a moved head with no collar under it is
 * just a misplaced version of the avatar already saved.
 *
 * `framing` is the `avatarFraming` switch. With it off `contentScale` stays at
 * the scale each family already shipped with, so only the callers that ask for
 * centering get it.
 */
export function avatarSvgComposition(
  config: ResolvedAvatarSvgConfig,
  {
    neckSweater,
    framing,
  }: { readonly neckSweater: boolean; readonly framing: boolean },
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
      headOffsetY: 0,
      contentOffsetY: 0,
      // Legacy heads are drawn without a neck, and this is the scale that has
      // always sized them against the rest. It is the framing rule for that
      // family: their artwork bounds are not derivable from a config.
      contentScale: 1.25,
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
    const bounds = composerContentBounds(config, 0, false);
    return {
      behind: [],
      head,
      front: [],
      headOffsetY: 0,
      contentOffsetY: contentOffsetY(bounds),
      contentScale: framing ? contentScale(bounds) : 1,
    };
  }
  const headOffsetY = AVATAR_CHIN_BASELINE_Y - AVATAR_FACE_CHIN_Y[config.face];
  const bounds = composerContentBounds(config, headOffsetY, true);
  return {
    behind: [avatarComposerAssetUrl(`neck/${config.skin}.svg`)],
    head,
    front: [avatarComposerAssetUrl(`sweater/${config.sweater}.svg`)],
    headOffsetY: (headOffsetY / 380) * 100,
    contentOffsetY: contentOffsetY(bounds),
    contentScale: framing ? contentScale(bounds) : 1,
  };
}

export function randomAvatarSvgConfig(): AvatarSvgConfig {
  return randomAvatarComposerConfig();
}
