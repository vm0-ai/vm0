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

const SVG_RAW_CHUNKS = Object.freeze(
  import.meta.glob<string>("./assets/avatar-svg/*.svg", {
    eager: false,
    query: "?raw",
    import: "default",
  }),
);

function loadRawAsset(filename: string): Promise<string> {
  const key = `./assets/avatar-svg/${filename}`;
  const loader = SVG_RAW_CHUNKS[key];
  if (!loader) {
    throw new Error(`Missing avatar SVG asset: ${filename}`);
  }
  return loader();
}

/** Extract the inner content of an SVG string (everything between <svg> and </svg>). */
function extractSvgInner(raw: string): string {
  const open = raw.indexOf(">", raw.indexOf("<svg"));
  const close = raw.lastIndexOf("</svg>");
  if (open === -1 || close === -1) {
    return "";
  }
  return raw.slice(open + 1, close);
}

/**
 * Load the 3 SVG layers for a config and return a data-URL of the combined SVG.
 */
export async function loadCompositeAvatarSvg(
  config: AvatarSvgConfig,
): Promise<string> {
  const [head, face, hair] = await Promise.all([
    loadRawAsset(`head-r${config.rotation}-s${config.skin}.svg`),
    loadRawAsset(
      `face-r${config.rotation}-f${config.expression}-${config.intensity}.svg`,
    ),
    loadRawAsset(
      `hair-r${config.rotation}-h${config.hairStyle}-c${config.hairColor}.svg`,
    ),
  ]);
  const inner =
    extractSvgInner(head) + extractSvgInner(face) + extractSvgInner(hair);
  const svg = `<svg viewBox="0 0 480 480" fill="none" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
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
