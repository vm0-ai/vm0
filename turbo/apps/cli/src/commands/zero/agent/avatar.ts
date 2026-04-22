const SKIN_MAP: Record<string, number> = {
  light: 0,
  "light-medium": 1,
  medium: 2,
  "medium-dark": 3,
  dark: 4,
};

const HAIR_COLOR_MAP: Record<string, number> = {
  blonde: 1,
  teal: 2,
  grey: 3,
  pink: 4,
  brown: 5,
};

const EXPRESSION_MAP: Record<string, number> = {
  calm: 1,
  content: 2,
  neutral: 3,
  pleasant: 4,
  excited: 5,
};

const INTENSITY_MAP: Record<string, "d" | "m" | "h"> = {
  chill: "d",
  normal: "m",
  hyped: "h",
};

function lookupRequired<T>(
  value: string,
  map: Readonly<Record<string, T>>,
  flag: string,
): T {
  if (!(value in map)) {
    throw new Error(
      `Invalid ${flag} "${value}". Must be one of: ${Object.keys(map).join(", ")}`,
    );
  }
  return map[value]!;
}

function parseIntRange(
  value: string,
  flag: string,
  min: number,
  max: number,
): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${flag} "${value}". Must be ${min}–${max}`);
  }
  return n;
}

function buildCustomSvgAvatar(opts: AvatarOptions): string {
  const r =
    opts.avatarRotation !== undefined
      ? parseIntRange(opts.avatarRotation, "--avatar-rotation", 1, 5)
      : 3;
  const h =
    opts.avatarHairStyle !== undefined
      ? parseIntRange(opts.avatarHairStyle, "--avatar-hair-style", 1, 5)
      : 1;
  const s =
    opts.avatarSkin !== undefined
      ? lookupRequired(opts.avatarSkin, SKIN_MAP, "--avatar-skin")
      : 2;
  const c =
    opts.avatarHairColor !== undefined
      ? lookupRequired(
          opts.avatarHairColor,
          HAIR_COLOR_MAP,
          "--avatar-hair-color",
        )
      : 5;
  const f =
    opts.avatarExpression !== undefined
      ? lookupRequired(
          opts.avatarExpression,
          EXPRESSION_MAP,
          "--avatar-expression",
        )
      : 1;
  const i =
    opts.avatarIntensity !== undefined
      ? lookupRequired(
          opts.avatarIntensity,
          INTENSITY_MAP,
          "--avatar-intensity",
        )
      : "m";
  return `svg:r${r}s${s}h${h}c${c}f${f}${i}`;
}

export interface AvatarOptions {
  avatar?: string;
  avatarRotation?: string;
  avatarSkin?: string;
  avatarHairStyle?: string;
  avatarHairColor?: string;
  avatarExpression?: string;
  avatarIntensity?: string;
}

export function resolveAvatarUrl(opts: AvatarOptions): string | undefined {
  const hasPreset = opts.avatar !== undefined;
  const hasCustom =
    opts.avatarRotation !== undefined ||
    opts.avatarSkin !== undefined ||
    opts.avatarHairStyle !== undefined ||
    opts.avatarHairColor !== undefined ||
    opts.avatarExpression !== undefined ||
    opts.avatarIntensity !== undefined;

  if (!hasPreset && !hasCustom) return undefined;

  if (hasPreset && hasCustom) {
    throw new Error(
      "--avatar cannot be combined with --avatar-* attribute options",
    );
  }

  if (hasPreset) {
    if (!/^preset:[0-4]$/.test(opts.avatar!)) {
      throw new Error(
        `Invalid --avatar "${opts.avatar}". Use preset:0 through preset:4`,
      );
    }
    return opts.avatar;
  }

  return buildCustomSvgAvatar(opts);
}

const REVERSE_SKIN_MAP: Record<number, string> = {
  0: "light",
  1: "light-medium",
  2: "medium",
  3: "medium-dark",
  4: "dark",
};

const REVERSE_HAIR_COLOR_MAP: Record<number, string> = {
  1: "blonde",
  2: "teal",
  3: "grey",
  4: "pink",
  5: "brown",
};

const REVERSE_EXPRESSION_MAP: Record<number, string> = {
  1: "calm",
  2: "content",
  3: "neutral",
  4: "pleasant",
  5: "excited",
};

const REVERSE_INTENSITY_MAP: Record<string, string> = {
  d: "chill",
  m: "normal",
  h: "hyped",
};

const PRESET_DESCRIPTIONS: Record<string, string> = {
  "preset:0": "light skin, brown hair, calm, hyped",
  "preset:1": "light-medium skin, grey hair, calm, normal",
  "preset:2": "medium skin, pink hair, neutral, chill",
  "preset:3": "medium-dark skin, blonde hair, pleasant, hyped",
  "preset:4": "dark skin, teal hair, excited, normal",
};

function parseSvgAvatar(svg: string): string | undefined {
  const match = svg.match(/^svg:r(\d)s(\d)h(\d)c(\d)f(\d)([dmh])$/);
  if (!match) return undefined;

  const [, r, s, h, c, f, i] = match as RegExpExecArray;
  const parts: string[] = [];

  const skin = REVERSE_SKIN_MAP[Number(s)];
  if (skin) parts.push(`${skin} skin`);

  const hairColor = REVERSE_HAIR_COLOR_MAP[Number(c)];
  if (hairColor) parts.push(`${hairColor} hair`);

  const expression = REVERSE_EXPRESSION_MAP[Number(f)];
  if (expression) parts.push(expression);

  const intensity = REVERSE_INTENSITY_MAP[i!];
  if (intensity) parts.push(intensity);

  if (parts.length === 0) return undefined;

  let desc = parts.join(", ");
  if (r !== "3") {
    const rotationLabels: Record<string, string> = {
      "1": "far-left",
      "2": "left",
      "4": "right",
      "5": "far-right",
    };
    const rot = rotationLabels[r!];
    if (rot) desc += `, ${rot}`;
  }
  if (h !== "1") {
    desc += `, hair style ${h}`;
  }

  return desc;
}

export function formatAvatar(
  avatarUrl: string | null | undefined,
): string | undefined {
  if (!avatarUrl) return undefined;

  if (avatarUrl.startsWith("preset:")) {
    const desc = PRESET_DESCRIPTIONS[avatarUrl];
    return desc ? `${avatarUrl} (${desc})` : avatarUrl;
  }

  if (avatarUrl.startsWith("svg:")) {
    const desc = parseSvgAvatar(avatarUrl);
    return desc ? `custom (${desc})` : avatarUrl;
  }

  return avatarUrl;
}
