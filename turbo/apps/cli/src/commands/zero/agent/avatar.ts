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
