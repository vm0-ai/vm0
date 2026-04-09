export const AVATAR_SVG_PREFIX = "svg:";

export interface AvatarSvgConfig {
  rotation: number; // 1-5
  skin: number; // 0-4
  hairStyle: number; // 1-5
  hairColor: number; // 1-5 (1=yellow, 2=teal, 3=grey, 4=pink, 5=brown)
  expression: number; // 1-5
  intensity: "d" | "m" | "h"; // default, medium, high
}

const INTENSITY_MAP = {
  d: "d",
  m: "m",
  h: "h",
} as const;

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

const SVG_ASSETS = Object.freeze(
  import.meta.glob<string>("./assets/avatar-svg/*.svg", {
    eager: true,
    import: "default",
  }),
);

function resolveAsset(filename: string): string {
  const key = `./assets/avatar-svg/${filename}`;
  const url = SVG_ASSETS[key];
  if (!url) {
    throw new Error(`Missing avatar SVG asset: ${filename}`);
  }
  return url;
}

export function headSvgUrl(rotation: number, skin: number): string {
  return resolveAsset(`head-r${rotation}-s${skin}.svg`);
}

export function hairSvgUrl(
  rotation: number,
  style: number,
  color: number,
): string {
  return resolveAsset(`hair-r${rotation}-h${style}-c${color}.svg`);
}

export function faceSvgUrl(
  rotation: number,
  expression: number,
  intensity: string,
): string {
  return resolveAsset(`face-r${rotation}-f${expression}-${intensity}.svg`);
}

export function randomAvatarSvgConfig(): AvatarSvgConfig {
  const rand = (min: number, max: number) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  };
  const intensities = ["d", "m", "h"] as const;
  return {
    rotation: rand(1, 5),
    skin: rand(0, 4),
    hairStyle: rand(1, 5),
    hairColor: rand(1, 5),
    expression: rand(1, 5),
    intensity: intensities[rand(0, 2)]!,
  };
}
