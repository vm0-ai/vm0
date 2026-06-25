import { deflateSync } from "node:zlib";

import type {
  ZeroMapsOsmDownloadRequest,
  ZeroMapsOsmRenderRequest,
  ZeroMapsResponse,
} from "@vm0/api-contracts/contracts/zero-maps";
import { command } from "ccstate";

import type { AuthContext } from "../../types/auth";
import { safeJsonParse } from "../utils";
import {
  checkMapsCredits$,
  recordMapsUsage$,
  type MapsErrorResponse,
} from "./zero-maps.service";

const PROVIDER = "openstreetmap";
const DOWNLOAD_CATEGORY = "osm.download";
const RENDER_CATEGORY = "osm.render.png";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const ATTRIBUTION = "© OpenStreetMap contributors";
const MAX_BBOX_AREA_SQUARE_METERS = 50_000_000;
const MAX_MERCATOR_LATITUDE = 85.051_129;
const MAX_FEATURES = 2500;

interface AuthedMapsArgs<TBody> {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: TBody;
}

interface BoundingBox {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

interface OverpassElement {
  readonly type: "node" | "way" | "relation";
  readonly id: number;
  readonly tags?: Readonly<Record<string, string>>;
  readonly geometry?: readonly {
    readonly lat: number;
    readonly lon: number;
  }[];
}

interface OverpassResponse {
  readonly elements?: readonly OverpassElement[];
}

type OsmLayer = ZeroMapsOsmDownloadRequest["layers"][number];

interface OsmFeature {
  readonly id: string;
  readonly layer: OsmLayer;
  readonly tags: Readonly<Record<string, string>>;
  readonly coordinates: readonly LatLng[];
  readonly polygon: boolean;
}

interface GeoJsonFeature {
  readonly type: "Feature";
  readonly properties: {
    readonly id: string;
    readonly layer: OsmLayer;
    readonly tags: Readonly<Record<string, string>>;
  };
  readonly geometry: {
    readonly type: "LineString" | "Polygon";
    readonly coordinates:
      | readonly (readonly [number, number])[]
      | readonly (readonly (readonly [number, number])[])[];
  };
}

interface GeoJsonFeatureCollection {
  readonly type: "FeatureCollection";
  readonly features: readonly GeoJsonFeature[];
}

interface RenderPalette {
  readonly background: string;
  readonly road: string;
  readonly buildingFill: string;
  readonly buildingStroke: string;
  readonly waterFill: string;
  readonly waterStroke: string;
  readonly parkFill: string;
  readonly parkStroke: string;
  readonly markerFill: string;
  readonly markerStroke: string;
  readonly text: string;
  readonly textHalo: string;
  readonly attribution: string;
}

interface Color {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

interface RasterPalette {
  readonly background: Color;
  readonly road: Color;
  readonly buildingFill: Color;
  readonly buildingStroke: Color;
  readonly waterFill: Color;
  readonly waterStroke: Color;
  readonly parkFill: Color;
  readonly parkStroke: Color;
  readonly markerFill: Color;
  readonly markerStroke: Color;
  readonly text: Color;
  readonly textHalo: Color;
  readonly attribution: Color;
}

interface RasterImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

interface RasterRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface LineStyle {
  readonly width: number;
  readonly color: Color;
  readonly opacity: number;
}

interface TextPlacement {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

interface HaloTextStyle {
  readonly color: Color;
  readonly halo: Color;
}

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function badRequest(message: string): MapsErrorResponse {
  return { status: 400, body: errorBody(message, "BAD_REQUEST") };
}

function badGateway(message: string): MapsErrorResponse {
  return { status: 502, body: errorBody(message, "OPENSTREETMAP_ERROR") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOverpassResponse(value: unknown): value is OverpassResponse {
  return (
    isRecord(value) &&
    (value.elements === undefined || Array.isArray(value.elements))
  );
}

function bboxFromRequest(
  request: ZeroMapsOsmDownloadRequest | ZeroMapsOsmRenderRequest,
): BoundingBox {
  if (request.bbox) {
    return request.bbox;
  }
  const center = request.center;
  const radiusMeters = request.radiusMeters;
  if (!center || radiusMeters === undefined) {
    throw new Error("Validated OSM request was missing an area");
  }
  const latDelta = radiusMeters / 111_320;
  const lngDelta =
    radiusMeters /
    (111_320 * Math.max(Math.cos((center.lat * Math.PI) / 180), 0.01));
  return {
    west: center.lng - lngDelta,
    south: center.lat - latDelta,
    east: center.lng + lngDelta,
    north: center.lat + latDelta,
  };
}

function bboxAreaSquareMeters(bbox: BoundingBox): number {
  const midLat = ((bbox.north + bbox.south) / 2) * (Math.PI / 180);
  const width = (bbox.east - bbox.west) * 111_320 * Math.cos(midLat);
  const height = (bbox.north - bbox.south) * 111_320;
  return Math.abs(width * height);
}

function validateBbox(bbox: BoundingBox): MapsErrorResponse | null {
  if (bbox.east <= bbox.west || bbox.north <= bbox.south) {
    return badRequest("bbox east/north must be greater than west/south");
  }
  if (
    bbox.west < -180 ||
    bbox.east > 180 ||
    bbox.south < -MAX_MERCATOR_LATITUDE ||
    bbox.north > MAX_MERCATOR_LATITUDE
  ) {
    return badRequest(
      "OSM bbox must stay within WGS84 longitude and Web Mercator latitude bounds",
    );
  }
  if (bboxAreaSquareMeters(bbox) > MAX_BBOX_AREA_SQUARE_METERS) {
    return badRequest("OSM bbox is too large; use a smaller area");
  }
  return null;
}

function overpassFilter(layer: OsmLayer): readonly string[] {
  if (layer === "roads") {
    return ['way["highway"]'];
  }
  if (layer === "buildings") {
    return ['way["building"]'];
  }
  if (layer === "water") {
    return ['way["natural"="water"]', 'way["waterway"]'];
  }
  return [
    'way["leisure"="park"]',
    'way["landuse"~"^(grass|forest|recreation_ground|meadow)$"]',
  ];
}

function buildOverpassQuery(
  bbox: BoundingBox,
  layers: readonly OsmLayer[],
): string {
  const box = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const selectors = layers.flatMap(overpassFilter);
  const body = selectors
    .map((selector) => {
      return `  ${selector}(${box});`;
    })
    .join("\n");
  return `[out:json][timeout:20];\n(\n${body}\n);\nout geom ${MAX_FEATURES + 1};`;
}

async function fetchOverpass(
  bbox: BoundingBox,
  layers: readonly OsmLayer[],
  signal: AbortSignal,
): Promise<readonly OsmFeature[] | MapsErrorResponse> {
  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "vm0-zero-maps/1.0 (https://vm0.ai)",
    },
    body: new URLSearchParams({ data: buildOverpassQuery(bbox, layers) }),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    return badGateway(text.trim() || "OpenStreetMap Overpass request failed");
  }
  const parsed = safeJsonParse(text);
  if (!isOverpassResponse(parsed)) {
    return badGateway("OpenStreetMap Overpass returned invalid JSON");
  }
  const features = (parsed.elements ?? [])
    .map(elementToFeature)
    .filter((feature): feature is OsmFeature => {
      return feature !== null && layers.includes(feature.layer);
    });
  if (features.length > MAX_FEATURES) {
    return badRequest("OSM feature count is too high; use a smaller area");
  }
  return features;
}

function elementToFeature(element: OverpassElement): OsmFeature | null {
  if (
    element.type !== "way" ||
    !element.geometry ||
    element.geometry.length < 2
  ) {
    return null;
  }
  const tags = element.tags ?? {};
  const layer = classifyLayer(tags);
  if (!layer) {
    return null;
  }
  const coordinates = element.geometry.map((point) => {
    return { lat: point.lat, lng: point.lon };
  });
  const closed =
    coordinates.length > 2 &&
    coordinates[0]?.lat === coordinates.at(-1)?.lat &&
    coordinates[0]?.lng === coordinates.at(-1)?.lng;
  return {
    id: `${element.type}/${element.id}`,
    layer,
    tags,
    coordinates,
    polygon: layer !== "roads" && closed,
  };
}

function classifyLayer(
  tags: Readonly<Record<string, string>>,
): OsmLayer | null {
  if (tags.highway) {
    return "roads";
  }
  if (tags.building) {
    return "buildings";
  }
  if (tags.natural === "water" || tags.waterway) {
    return "water";
  }
  if (
    tags.leisure === "park" ||
    ["grass", "forest", "recreation_ground", "meadow"].includes(
      tags.landuse ?? "",
    )
  ) {
    return "parks";
  }
  return null;
}

function toGeoJson(features: readonly OsmFeature[]): GeoJsonFeatureCollection {
  return {
    type: "FeatureCollection",
    features: features.map((feature) => {
      const coordinates = feature.coordinates.map((point) => {
        return [point.lng, point.lat] as const;
      });
      return {
        type: "Feature",
        properties: {
          id: feature.id,
          layer: feature.layer,
          tags: feature.tags,
        },
        geometry: feature.polygon
          ? { type: "Polygon", coordinates: [coordinates] }
          : { type: "LineString", coordinates },
      };
    }),
  };
}

function runIdForUsage(auth: AuthContext): string | undefined {
  return auth.tokenType === "zero" || auth.tokenType === "sandbox"
    ? auth.runId
    : undefined;
}

function isMapsErrorResponse(
  value: readonly OsmFeature[] | MapsErrorResponse,
): value is MapsErrorResponse {
  return !Array.isArray(value);
}

function mercatorY(lat: number): number {
  const radians = (lat * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + radians / 2));
}

function projector(bbox: BoundingBox, width: number, height: number) {
  const north = mercatorY(bbox.north);
  const south = mercatorY(bbox.south);
  return (point: LatLng): { readonly x: number; readonly y: number } => {
    return {
      x: ((point.lng - bbox.west) / (bbox.east - bbox.west)) * width,
      y: ((north - mercatorY(point.lat)) / (north - south)) * height,
    };
  };
}

function roadWidth(tags: Readonly<Record<string, string>>): number {
  if (["motorway", "trunk", "primary"].includes(tags.highway ?? "")) {
    return 3.2;
  }
  if (["secondary", "tertiary"].includes(tags.highway ?? "")) {
    return 2.2;
  }
  if (["footway", "path", "pedestrian", "steps"].includes(tags.highway ?? "")) {
    return 0.9;
  }
  return 1.4;
}

function paletteForStyle(
  style: ZeroMapsOsmRenderRequest["style"],
): RenderPalette {
  if (style === "guide") {
    return {
      background: "#f7f1e7",
      road: "#b79a72",
      buildingFill: "#d7cbb7",
      buildingStroke: "#c2b39c",
      waterFill: "#9fcbd5",
      waterStroke: "#87b9c4",
      parkFill: "#b9c9a6",
      parkStroke: "#9ead8a",
      markerFill: "#2b7c8e",
      markerStroke: "#fff9ed",
      text: "#29241e",
      textHalo: "#f7f1e7",
      attribution: "#766b5d",
    };
  }
  return {
    background: "#f8fafc",
    road: "#94a3b8",
    buildingFill: "#d1d5db",
    buildingStroke: "#9ca3af",
    waterFill: "#bae6fd",
    waterStroke: "#7dd3fc",
    parkFill: "#bbf7d0",
    parkStroke: "#86efac",
    markerFill: "#2563eb",
    markerStroke: "#eff6ff",
    text: "#111827",
    textHalo: "#f8fafc",
    attribution: "#64748b",
  };
}

function parseColor(hex: string): Color {
  const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
  const value =
    normalized.length === 3
      ? normalized
          .split("")
          .map((character) => {
            return `${character}${character}`;
          })
          .join("")
      : normalized;
  const integer = Number.parseInt(value, 16);
  return {
    r: (integer >> 16) & 255,
    g: (integer >> 8) & 255,
    b: integer & 255,
  };
}

function rasterPaletteForStyle(
  style: ZeroMapsOsmRenderRequest["style"],
): RasterPalette {
  const palette = paletteForStyle(style);
  return {
    background: parseColor(palette.background),
    road: parseColor(palette.road),
    buildingFill: parseColor(palette.buildingFill),
    buildingStroke: parseColor(palette.buildingStroke),
    waterFill: parseColor(palette.waterFill),
    waterStroke: parseColor(palette.waterStroke),
    parkFill: parseColor(palette.parkFill),
    parkStroke: parseColor(palette.parkStroke),
    markerFill: parseColor(palette.markerFill),
    markerStroke: parseColor(palette.markerStroke),
    text: parseColor(palette.text),
    textHalo: parseColor(palette.textHalo),
    attribution: parseColor(palette.attribution),
  };
}

function createImage(
  width: number,
  height: number,
  background: Color,
): RasterImage {
  const data = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = background.r;
    data[offset + 1] = background.g;
    data[offset + 2] = background.b;
    data[offset + 3] = 255;
  }
  return { width, height, data };
}

function blendPixel(
  image: RasterImage,
  x: number,
  y: number,
  color: Color,
  opacity: number,
) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
    return;
  }
  const alpha = Math.max(0, Math.min(1, opacity));
  const offset = (y * image.width + x) * 4;
  const inverse = 1 - alpha;
  const currentRed = image.data[offset] ?? 0;
  const currentGreen = image.data[offset + 1] ?? 0;
  const currentBlue = image.data[offset + 2] ?? 0;
  image.data[offset] = Math.round(color.r * alpha + currentRed * inverse);
  image.data[offset + 1] = Math.round(color.g * alpha + currentGreen * inverse);
  image.data[offset + 2] = Math.round(color.b * alpha + currentBlue * inverse);
  image.data[offset + 3] = 255;
}

function fillRect(image: RasterImage, rect: RasterRect, color: Color) {
  for (let row = rect.y; row < rect.y + rect.height; row += 1) {
    for (let column = rect.x; column < rect.x + rect.width; column += 1) {
      blendPixel(image, column, row, color, 1);
    }
  }
}

function drawSegment(
  image: RasterImage,
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  style: LineStyle,
) {
  const radius = Math.max(style.width / 2, 0.5);
  const minX = Math.floor(Math.min(start.x, end.x) - radius);
  const maxX = Math.ceil(Math.max(start.x, end.x) + radius);
  const minY = Math.floor(Math.min(start.y, end.y) - radius);
  const maxY = Math.ceil(Math.max(start.y, end.y) + radius);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const radiusSquared = radius * radius;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const t =
        lengthSquared === 0
          ? 0
          : Math.max(
              0,
              Math.min(
                1,
                ((px - start.x) * dx + (py - start.y) * dy) / lengthSquared,
              ),
            );
      const closestX = start.x + t * dx;
      const closestY = start.y + t * dy;
      const distanceX = px - closestX;
      const distanceY = py - closestY;
      if (distanceX * distanceX + distanceY * distanceY <= radiusSquared) {
        blendPixel(image, x, y, style.color, style.opacity);
      }
    }
  }
}

function drawPolyline(
  image: RasterImage,
  points: readonly { readonly x: number; readonly y: number }[],
  width: number,
  color: Color,
  opacity: number,
) {
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous && current) {
      drawSegment(image, previous, current, { width, color, opacity });
    }
  }
}

function closePolyline(
  points: readonly { readonly x: number; readonly y: number }[],
) {
  const first = points[0];
  return first ? [...points, first] : points;
}

function drawCircle(
  image: RasterImage,
  center: { readonly x: number; readonly y: number },
  radius: number,
  color: Color,
  opacity: number,
) {
  const minX = Math.floor(center.x - radius);
  const maxX = Math.ceil(center.x + radius);
  const minY = Math.floor(center.y - radius);
  const maxY = Math.ceil(center.y + radius);
  const radiusSquared = radius * radius;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x + 0.5 - center.x;
      const dy = y + 0.5 - center.y;
      if (dx * dx + dy * dy <= radiusSquared) {
        blendPixel(image, x, y, color, opacity);
      }
    }
  }
}

function fillPolygon(
  image: RasterImage,
  points: readonly { readonly x: number; readonly y: number }[],
  color: Color,
  opacity: number,
) {
  if (points.length < 3) {
    return;
  }
  const yValues = points.map((point) => {
    return point.y;
  });
  const minY = Math.max(0, Math.floor(Math.min(...yValues)));
  const maxY = Math.min(image.height - 1, Math.ceil(Math.max(...yValues)));

  for (let y = minY; y <= maxY; y += 1) {
    const scanY = y + 0.5;
    const intersections: number[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const start = points[index];
      const end = points[(index + 1) % points.length];
      if (!start || !end || start.y === end.y) {
        continue;
      }
      if (start.y > scanY !== end.y > scanY) {
        const x =
          start.x + ((scanY - start.y) * (end.x - start.x)) / (end.y - start.y);
        intersections.push(x);
      }
    }
    intersections.sort((left, right) => {
      return left - right;
    });
    for (let index = 0; index < intersections.length; index += 2) {
      const start = intersections[index];
      const end = intersections[index + 1];
      if (start === undefined || end === undefined) {
        continue;
      }
      const minX = Math.max(0, Math.ceil(start));
      const maxX = Math.min(image.width - 1, Math.floor(end));
      for (let x = minX; x <= maxX; x += 1) {
        blendPixel(image, x, y, color, opacity);
      }
    }
  }
}

const FONT_5X7: Readonly<Record<string, readonly string[]>> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
  ",": ["00000", "00000", "00000", "00000", "00100", "00100", "01000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "/": ["00001", "00010", "00100", "01000", "10000", "00000", "00000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

function normalizeRasterText(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, "?").toUpperCase();
}

function textWidth(value: string, scale: number): number {
  const text = normalizeRasterText(value);
  if (text.length === 0) {
    return 0;
  }
  return text.length * 6 * scale - scale;
}

function fittedText(value: string, scale: number, maxWidth: number): string {
  const text = normalizeRasterText(value);
  if (textWidth(text, scale) <= maxWidth) {
    return text;
  }
  let result = text;
  while (result.length > 1 && textWidth(`${result}.`, scale) > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result}.`;
}

function drawText(
  image: RasterImage,
  value: string,
  placement: TextPlacement,
  color: Color,
) {
  const text = normalizeRasterText(value);
  let cursor = Math.round(placement.x);
  const top = Math.round(placement.y);
  for (const character of text) {
    const glyph = FONT_5X7[character] ?? FONT_5X7["?"];
    if (!glyph) {
      continue;
    }
    for (let rowIndex = 0; rowIndex < glyph.length; rowIndex += 1) {
      const row = glyph[rowIndex];
      if (!row) {
        continue;
      }
      for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
        if (row[columnIndex] === "1") {
          fillRect(
            image,
            {
              x: cursor + columnIndex * placement.scale,
              y: top + rowIndex * placement.scale,
              width: placement.scale,
              height: placement.scale,
            },
            color,
          );
        }
      }
    }
    cursor += 6 * placement.scale;
  }
}

function drawTextWithHalo(
  image: RasterImage,
  value: string,
  placement: TextPlacement,
  style: HaloTextStyle,
) {
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      if (offsetX !== 0 || offsetY !== 0) {
        drawText(
          image,
          value,
          {
            x: placement.x + offsetX * placement.scale,
            y: placement.y + offsetY * placement.scale,
            scale: placement.scale,
          },
          style.halo,
        );
      }
    }
  }
  drawText(image, value, placement, style.color);
}

function renderFeature(
  image: RasterImage,
  palette: RasterPalette,
  feature: OsmFeature,
  points: readonly { readonly x: number; readonly y: number }[],
) {
  if (feature.layer === "roads") {
    drawPolyline(image, points, roadWidth(feature.tags), palette.road, 0.9);
    return;
  }
  if (!feature.polygon) {
    const stroke =
      feature.layer === "water" ? palette.waterStroke : palette.buildingStroke;
    drawPolyline(image, points, 1.2, stroke, 0.82);
    return;
  }
  if (feature.layer === "buildings") {
    fillPolygon(image, points, palette.buildingFill, 0.82);
    drawPolyline(
      image,
      closePolyline(points),
      0.8,
      palette.buildingStroke,
      0.82,
    );
    return;
  }
  if (feature.layer === "water") {
    fillPolygon(image, points, palette.waterFill, 0.85);
    drawPolyline(image, closePolyline(points), 1, palette.waterStroke, 0.85);
    return;
  }
  fillPolygon(image, points, palette.parkFill, 0.72);
  drawPolyline(image, closePolyline(points), 0.8, palette.parkStroke, 0.72);
}

function crc32(data: Uint8Array): number {
  let crc = 4_294_967_295;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (3_988_292_384 & mask);
    }
  }
  return (crc ^ 4_294_967_295) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBuffer, data])),
    8 + data.length,
  );
  return chunk;
}

function encodePng(image: RasterImage): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let row = 0; row < image.height; row += 1) {
    const rawOffset = row * (stride + 1);
    raw[rawOffset] = 0;
    image.data.copy(raw, rawOffset + 1, row * stride, (row + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function renderRasterMap(
  request: ZeroMapsOsmRenderRequest,
  bbox: BoundingBox,
  features: readonly OsmFeature[],
): Buffer {
  const { width, height } = request;
  const palette = rasterPaletteForStyle(request.style);
  const image = createImage(width, height, palette.background);
  const project = projector(bbox, width, height);
  const sorted = ["water", "parks", "buildings", "roads"] as const;
  const orderedFeatures = sorted.flatMap((layer) => {
    return features.filter((feature) => {
      return feature.layer === layer;
    });
  });
  for (const feature of orderedFeatures) {
    renderFeature(image, palette, feature, feature.coordinates.map(project));
  }

  for (let index = 0; index < request.markers.length; index += 1) {
    const marker = request.markers[index];
    if (!marker) {
      continue;
    }
    const point = project({ lat: marker.lat, lng: marker.lng });
    drawCircle(image, point, 13, palette.markerStroke, 1);
    drawCircle(image, point, 10, palette.markerFill, 1);
    const number = String(index + 1);
    const numberScale = 2;
    drawText(
      image,
      number,
      {
        x: point.x - textWidth(number, numberScale) / 2,
        y: point.y - 7,
        scale: numberScale,
      },
      palette.markerStroke,
    );
    const label = marker.label ?? number;
    const labelScale = 2;
    drawTextWithHalo(
      image,
      fittedText(label, labelScale, Math.max(30, width - point.x - 24)),
      { x: point.x + 16, y: point.y - 20, scale: labelScale },
      { color: palette.text, halo: palette.textHalo },
    );
  }

  if (request.title) {
    const titleScale = width < 500 ? 3 : 4;
    drawTextWithHalo(
      image,
      fittedText(request.title, titleScale, width - 56),
      { x: 28, y: 28, scale: titleScale },
      { color: palette.text, halo: palette.textHalo },
    );
  }

  const attribution = "(c) OpenStreetMap contributors";
  const attributionScale = width < 500 ? 1 : 2;
  const attributionText = fittedText(attribution, attributionScale, width - 24);
  drawTextWithHalo(
    image,
    attributionText,
    {
      x: width - textWidth(attributionText, attributionScale) - 12,
      y: height - 12 - 7 * attributionScale,
      scale: attributionScale,
    },
    { color: palette.attribution, halo: palette.textHalo },
  );

  return encodePng(image);
}

function renderPngBase64(
  request: ZeroMapsOsmRenderRequest,
  bbox: BoundingBox,
  features: readonly OsmFeature[],
): string {
  return renderRasterMap(request, bbox, features).toString("base64");
}

export const zeroMapsOsmDownload$ = command(
  async (
    { set },
    args: AuthedMapsArgs<ZeroMapsOsmDownloadRequest>,
    signal: AbortSignal,
  ) => {
    const bbox = bboxFromRequest(args.body);
    const bboxError = validateBbox(bbox);
    if (bboxError) {
      return bboxError;
    }
    const creditError = await set(
      checkMapsCredits$,
      {
        orgId: args.auth.orgId,
        provider: PROVIDER,
        category: DOWNLOAD_CATEGORY,
      },
      signal,
    );
    if (creditError) {
      return creditError;
    }
    const features = await fetchOverpass(bbox, args.body.layers, signal);
    signal.throwIfAborted();
    if (isMapsErrorResponse(features)) {
      return features;
    }
    const creditsCharged = await set(
      recordMapsUsage$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: runIdForUsage(args.auth),
        provider: PROVIDER,
        category: DOWNLOAD_CATEGORY,
      },
      signal,
    );
    const body: ZeroMapsResponse = {
      operation: "osm.download",
      provider: PROVIDER,
      creditsCharged,
      billingCategory: DOWNLOAD_CATEGORY,
      billingQuantity: 1,
      result: {
        bbox,
        layers: args.body.layers,
        attribution: ATTRIBUTION,
        featureCount: features.length,
        geojson: toGeoJson(features),
      },
    };
    return { status: 200 as const, body };
  },
);

export const zeroMapsOsmRender$ = command(
  async (
    { set },
    args: AuthedMapsArgs<ZeroMapsOsmRenderRequest>,
    signal: AbortSignal,
  ) => {
    const bbox = bboxFromRequest(args.body);
    const bboxError = validateBbox(bbox);
    if (bboxError) {
      return bboxError;
    }
    if (args.body.width * args.body.height > 4_194_304) {
      return badRequest("OSM render image is too large");
    }
    const creditError = await set(
      checkMapsCredits$,
      { orgId: args.auth.orgId, provider: PROVIDER, category: RENDER_CATEGORY },
      signal,
    );
    if (creditError) {
      return creditError;
    }
    const features = await fetchOverpass(bbox, args.body.layers, signal);
    signal.throwIfAborted();
    if (isMapsErrorResponse(features)) {
      return features;
    }
    const base64 = renderPngBase64(args.body, bbox, features);
    const creditsCharged = await set(
      recordMapsUsage$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: runIdForUsage(args.auth),
        provider: PROVIDER,
        category: RENDER_CATEGORY,
      },
      signal,
    );
    const body: ZeroMapsResponse = {
      operation: "osm.render",
      provider: PROVIDER,
      creditsCharged,
      billingCategory: RENDER_CATEGORY,
      billingQuantity: 1,
      result: {
        bbox,
        layers: args.body.layers,
        width: args.body.width,
        height: args.body.height,
        style: args.body.style,
        attribution: ATTRIBUTION,
        featureCount: features.length,
        image: {
          mimeType: "image/png",
          base64,
        },
      },
    };
    return { status: 200 as const, body };
  },
);
