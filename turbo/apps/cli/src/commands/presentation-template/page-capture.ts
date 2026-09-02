/**
 * Verification for rendered presentation page captures.
 *
 * A browser will hand back a picture of nothing. Three failures show up when
 * capturing HTML slides, and none of them raise an error:
 *
 * - a slide below the fold captures the page background, because the
 *   compositor never painted it;
 * - a capture taken mid-paint loses a band at one edge;
 * - fonts, images, and CSS background images land after first paint.
 *
 * Each capture is decoded and checked here before it is kept, so a deck of
 * blank pictures cannot reach publication unnoticed.
 */
import { inflateSync } from "node:zlib";

import type { PageGeometry } from "./capture-types";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Samples per axis when probing a capture for flat colour. */
const SAMPLE_STEPS = 24;

/** Shortest edge band worth reporting, in pixels. */
const MIN_BAND = 8;

/**
 * A band colour covering less of the interior than this is alien to the page,
 * which is what separates a mid-paint band from a slide that simply leaves its
 * lower half empty.
 */
const ALIEN_BAND_RATIO = 0.05;

const CHANNELS_BY_COLOR_TYPE: Readonly<Record<number, number>> = {
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4,
};

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly stride: number;
  readonly pixels: Buffer;
}

interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly colorType: number;
  readonly interlace: number;
}

interface PngChunks {
  readonly header: PngHeader;
  readonly data: Buffer;
}

function readChunks(buffer: Buffer): PngChunks {
  let offset = 8;
  let header: PngHeader | undefined;
  const idat: Buffer[] = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8] ?? 0,
        colorType: body[9] ?? -1,
        interlace: body[12] ?? 0,
      };
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (!header) {
    throw new Error("Capture has no PNG header");
  }
  return { header, data: Buffer.concat(idat) };
}

/** PNG filter type 4: the byte closest to left + above - upper-left. */
function paeth(left: number, up: number, upLeft: number): number {
  const predictor = left + up - upLeft;
  const dLeft = Math.abs(predictor - left);
  const dUp = Math.abs(predictor - up);
  const dUpLeft = Math.abs(predictor - upLeft);
  if (dLeft <= dUp && dLeft <= dUpLeft) {
    return left;
  }
  return dUp <= dUpLeft ? up : upLeft;
}

function reconstruct(
  filter: number,
  raw: number,
  left: number,
  up: number,
  upLeft: number,
): number {
  if (filter === 0) {
    return raw;
  }
  if (filter === 1) {
    return raw + left;
  }
  if (filter === 2) {
    return raw + up;
  }
  if (filter === 3) {
    return raw + ((left + up) >> 1);
  }
  if (filter === 4) {
    return raw + paeth(left, up, upLeft);
  }
  throw new Error(`Unsupported PNG row filter ${filter.toString()}`);
}

function unfilter(
  raw: Buffer,
  {
    width,
    height,
    channels,
  }: { width: number; height: number; channels: number },
): Buffer {
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let source = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[source] ?? 0;
    source += 1;
    const row = raw.subarray(source, source + stride);
    source += stride;
    const target = y * stride;
    const above = target - stride;

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[target + x - channels]! : 0;
      const up = y > 0 ? pixels[above + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[above + x - channels]! : 0;
      pixels[target + x] =
        reconstruct(filter, row[x] ?? 0, left, up, upLeft) & 0xff;
    }
  }

  return pixels;
}

/**
 * Decode the subset of PNG that Chromium emits: bit depth 8, non-interlaced,
 * colour types 0/2/4/6. Verification is worthless without real pixels, and a
 * decoder small enough to read is worth more here than an image dependency.
 */
export function decodePng(buffer: Buffer): DecodedPng {
  if (!buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error("Capture is not a PNG");
  }

  const { header, data } = readChunks(buffer);
  const channels = CHANNELS_BY_COLOR_TYPE[header.colorType];
  if (channels === undefined) {
    throw new Error(
      `Unsupported PNG colour type ${header.colorType.toString()}`,
    );
  }
  if (header.depth !== 8) {
    throw new Error(`Unsupported PNG bit depth ${header.depth.toString()}`);
  }
  if (header.interlace !== 0) {
    throw new Error("Interlaced PNG is not supported");
  }

  const { width, height } = header;
  return {
    width,
    height,
    channels,
    stride: width * channels,
    pixels: unfilter(inflateSync(data), { width, height, channels }),
  };
}

function pixelAt(image: DecodedPng, x: number, y: number): string {
  const at = y * image.stride + x * image.channels;
  if (image.channels >= 3) {
    return `${(image.pixels[at] ?? 0).toString()},${(image.pixels[at + 1] ?? 0).toString()},${(image.pixels[at + 2] ?? 0).toString()}`;
  }
  const grey = (image.pixels[at] ?? 0).toString();
  return `${grey},${grey},${grey}`;
}

/** Returns the row's single colour, or "" when the row is not uniform. */
function uniformRowColor(image: DecodedPng, y: number): string {
  const first = pixelAt(image, 0, y);
  for (let x = 1; x < image.width; x += 1) {
    if (pixelAt(image, x, y) !== first) {
      return "";
    }
  }
  return first;
}

function sampleGrid(
  image: DecodedPng,
  maxY: number,
  visit: (color: string) => void,
): void {
  for (let iy = 0; iy < SAMPLE_STEPS; iy += 1) {
    for (let ix = 0; ix < SAMPLE_STEPS; ix += 1) {
      const x = Math.min(
        image.width - 1,
        Math.round((ix / (SAMPLE_STEPS - 1)) * (image.width - 1)),
      );
      const y = Math.min(maxY, Math.round((iy / (SAMPLE_STEPS - 1)) * maxY));
      visit(pixelAt(image, x, y));
    }
  }
}

/**
 * Every rejection reason this returns is a failure observed in practice, not a
 * hypothetical. An empty array means the capture is usable.
 */
export function verifyCapture(
  image: DecodedPng,
  expected: PageGeometry,
  { edgeBand = true }: { edgeBand?: boolean } = {},
): string[] {
  if (image.width !== expected.width || image.height !== expected.height) {
    return [
      `expected ${expected.width.toString()}x${expected.height.toString()}, captured ${image.width.toString()}x${image.height.toString()}`,
    ];
  }

  const problems: string[] = [];

  // A slide that was never painted comes back as one flat colour, usually the
  // page background showing through where the slide should be.
  const distinct = new Set<string>();
  sampleGrid(image, image.height - 1, (color) => {
    distinct.add(color);
  });
  if (distinct.size === 1) {
    problems.push(
      `every sampled pixel is ${[...distinct][0] ?? ""}; the page rendered as one flat colour`,
    );
  }

  // A capture taken mid-paint loses a band at the bottom edge, filled with a
  // colour the page itself never uses. Only a live browser paints incrementally,
  // so a rasterised document page is never checked for this.
  const bandColor = edgeBand ? uniformRowColor(image, image.height - 1) : "";
  if (bandColor) {
    let band = 1;
    while (
      band < image.height &&
      uniformRowColor(image, image.height - 1 - band) === bandColor
    ) {
      band += 1;
    }
    if (band >= MIN_BAND && band <= image.height * 0.5) {
      let interior = 0;
      let matching = 0;
      sampleGrid(image, image.height - band - 1, (color) => {
        interior += 1;
        if (color === bandColor) {
          matching += 1;
        }
      });
      if (interior > 0 && matching / interior < ALIEN_BAND_RATIO) {
        problems.push(
          `bottom ${band.toString()}px is a flat ${bandColor} band absent from the rest of the page; captured mid-paint`,
        );
      }
    }
  }

  return problems;
}
