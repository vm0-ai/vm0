export const AVATAR_PRESET_PREFIX = "preset:";

export const AVATAR_COMPOSER_ASSET_VERSION = "v31-contained-hair-fill-20260830";
/**
 * The query string stores the selected layers. The base SVG is a transparent
 * fallback so clients that do not compose layers still show a valid avatar.
 */
export const AVATAR_COMPOSER_BASE_URL = `https://static.vm0.io/platform/views/zero-page/assets/avatar-svg-v2/${AVATAR_COMPOSER_ASSET_VERSION}/avatar.svg`;

export const AVATAR_COMPOSER_FACE_SHAPES = [
  "round",
  "square",
  "round-angled-ears",
  "tall",
  "wide",
  "oval",
] as const;
export const AVATAR_COMPOSER_HAIR_STYLES = [
  "high-bun",
  "geometric-long",
  "center-part",
  "curly-cap",
  "long-center-part",
  "sparse",
  "triple-bun",
  "rounded-crop",
  "halo",
  "topknot-locks",
  "low-pigtails",
  "ribbon-updo",
] as const;
export const AVATAR_COMPOSER_EXPRESSIONS = [
  "neutral-smile",
  "happy",
  "surprised",
  "worried",
  "wink",
  "angry",
  "frustrated",
  "calm",
  "bashful",
  "long-nose-smile",
  "toothy-grin",
  "side-smile",
  "full-beard",
  "whistling",
  "open-mouth",
  "angular-nose-smile",
  "gentle-smile",
  "u-nose-smile",
  "stubble-smile",
] as const;
export const AVATAR_COMPOSER_SKIN_TONES = [
  "gold",
  "light",
  "deep",
  "tan",
  "brown",
] as const;
export const AVATAR_COMPOSER_HAIR_COLORS = [
  "blue",
  "yellow",
  "green",
  "black",
  "brown",
] as const;

const FEMININE_AVATAR_HAIR_STYLES = new Set<AvatarComposerHairStyle>([
  "high-bun",
  "geometric-long",
  "long-center-part",
  "triple-bun",
  "topknot-locks",
  "low-pigtails",
  "ribbon-updo",
]);

export type AvatarComposerFaceShape =
  (typeof AVATAR_COMPOSER_FACE_SHAPES)[number];
export type AvatarComposerHairStyle =
  (typeof AVATAR_COMPOSER_HAIR_STYLES)[number];
export type AvatarComposerExpression =
  (typeof AVATAR_COMPOSER_EXPRESSIONS)[number];
export type AvatarComposerSkinTone =
  (typeof AVATAR_COMPOSER_SKIN_TONES)[number];
export type AvatarComposerHairColor =
  (typeof AVATAR_COMPOSER_HAIR_COLORS)[number];

export interface AvatarComposerConfig {
  readonly face: AvatarComposerFaceShape;
  readonly hair: AvatarComposerHairStyle;
  readonly expression: AvatarComposerExpression;
  readonly skin: AvatarComposerSkinTone;
  readonly hairColor: AvatarComposerHairColor;
}

export type AvatarComposerSelection =
  | { readonly field: "face"; readonly value: AvatarComposerFaceShape }
  | { readonly field: "hair"; readonly value: AvatarComposerHairStyle }
  | { readonly field: "expression"; readonly value: AvatarComposerExpression }
  | { readonly field: "skin"; readonly value: AvatarComposerSkinTone }
  | { readonly field: "hairColor"; readonly value: AvatarComposerHairColor };

/** Avatar used by the default assistant across branded chat surfaces. */
export const DEFAULT_AGENT_AVATAR_URL =
  "https://static.vm0.io/public/default-agent-avatar-ceb298b79964.svg";

/** Keep the organization default agent on its canonical avatar. */
export function agentAvatarUrlForDefaultAgent(args: {
  readonly agentId: string;
  readonly defaultAgentId: string | null;
  readonly avatarUrl: string | null;
}): string | null {
  return args.agentId === args.defaultAgentId
    ? DEFAULT_AGENT_AVATAR_URL
    : args.avatarUrl;
}

/** Number of legacy built-in preset avatars kept for existing agent data. */
export const AVATAR_PRESET_COUNT = 5;

function oneOf<const Item>(items: readonly Item[]): Item {
  const item = items[Math.floor(Math.random() * items.length)];
  if (item === undefined) {
    throw new Error("Cannot select from an empty avatar option list");
  }
  return item;
}

function isOneOf<const Items extends readonly string[]>(
  value: string | null,
  items: Items,
): value is Items[number] {
  return (
    value !== null &&
    items.some((item) => {
      return item === value;
    })
  );
}

export function isAvatarComposerCombinationCompatible(
  hair: AvatarComposerHairStyle,
  expression: AvatarComposerExpression,
): boolean {
  return !(
    expression === "full-beard" && FEMININE_AVATAR_HAIR_STYLES.has(hair)
  );
}

export function updateAvatarComposerConfig(
  config: AvatarComposerConfig,
  selection: AvatarComposerSelection,
): AvatarComposerConfig {
  switch (selection.field) {
    case "face":
      return { ...config, face: selection.value };
    case "hair":
      return isAvatarComposerCombinationCompatible(
        selection.value,
        config.expression,
      )
        ? { ...config, hair: selection.value }
        : config;
    case "expression": {
      const hair = isAvatarComposerCombinationCompatible(
        config.hair,
        selection.value,
      )
        ? config.hair
        : AVATAR_COMPOSER_HAIR_STYLES.find((candidate) => {
            return isAvatarComposerCombinationCompatible(
              candidate,
              selection.value,
            );
          });
      if (!hair) {
        throw new Error("Avatar expression has no compatible hairstyle");
      }
      return { ...config, hair, expression: selection.value };
    }
    case "skin":
      return { ...config, skin: selection.value };
    case "hairColor":
      return { ...config, hairColor: selection.value };
  }
}

export function randomAvatarComposerConfig(): AvatarComposerConfig {
  const expression = oneOf(AVATAR_COMPOSER_EXPRESSIONS);
  const compatibleHairStyles = AVATAR_COMPOSER_HAIR_STYLES.filter((hair) => {
    return isAvatarComposerCombinationCompatible(hair, expression);
  });
  return {
    face: oneOf(AVATAR_COMPOSER_FACE_SHAPES),
    hair: oneOf(compatibleHairStyles),
    expression,
    skin: oneOf(AVATAR_COMPOSER_SKIN_TONES),
    hairColor: oneOf(AVATAR_COMPOSER_HAIR_COLORS),
  };
}

export function avatarComposerUrl(config: AvatarComposerConfig): string {
  const query = new URLSearchParams({
    face: config.face,
    hair: config.hair,
    expression: config.expression,
    skin: config.skin,
    hairColor: config.hairColor,
  });
  return `${AVATAR_COMPOSER_BASE_URL}?${query}`;
}

export function parseAvatarComposerUrl(
  value: string | null | undefined,
): AvatarComposerConfig | null {
  if (!value?.startsWith(`${AVATAR_COMPOSER_BASE_URL}?`)) {
    return null;
  }
  const query = new URL(value).searchParams;
  const face = query.get("face");
  const hair = query.get("hair");
  const expression = query.get("expression");
  const skin = query.get("skin");
  const hairColor = query.get("hairColor");
  if (
    !isOneOf(face, AVATAR_COMPOSER_FACE_SHAPES) ||
    !isOneOf(hair, AVATAR_COMPOSER_HAIR_STYLES) ||
    !isOneOf(expression, AVATAR_COMPOSER_EXPRESSIONS) ||
    !isOneOf(skin, AVATAR_COMPOSER_SKIN_TONES) ||
    !isOneOf(hairColor, AVATAR_COMPOSER_HAIR_COLORS) ||
    !isAvatarComposerCombinationCompatible(hair, expression)
  ) {
    return null;
  }
  return { face, hair, expression, skin, hairColor };
}

export function randomAvatarUrl(): string {
  return avatarComposerUrl(randomAvatarComposerConfig());
}
