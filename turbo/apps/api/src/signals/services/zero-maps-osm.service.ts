import { Resvg } from "@resvg/resvg-js";
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

function pathForPoints(
  points: readonly { readonly x: number; readonly y: number }[],
): string {
  return points
    .map((point, index) => {
      const commandName = index === 0 ? "M" : "L";
      return `${commandName}${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    })
    .join(" ");
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

function renderSvg(
  request: ZeroMapsOsmRenderRequest,
  bbox: BoundingBox,
  features: readonly OsmFeature[],
): string {
  const { width, height } = request;
  const palette = paletteForStyle(request.style);
  const project = projector(bbox, width, height);
  const sorted = ["water", "parks", "buildings", "roads"] as const;
  const featureMarkup = sorted
    .flatMap((layer) => {
      return features.filter((feature) => {
        return feature.layer === layer;
      });
    })
    .map((feature) => {
      const path = pathForPoints(feature.coordinates.map(project));
      if (feature.layer === "roads") {
        return `<path d="${path}" fill="none" stroke="${palette.road}" stroke-width="${roadWidth(feature.tags)}" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`;
      }
      if (!feature.polygon) {
        const stroke =
          feature.layer === "water"
            ? palette.waterStroke
            : palette.buildingStroke;
        return `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.82"/>`;
      }
      if (feature.layer === "buildings") {
        return `<path d="${path} Z" fill="${palette.buildingFill}" stroke="${palette.buildingStroke}" stroke-width="0.5" opacity="0.82"/>`;
      }
      if (feature.layer === "water") {
        return `<path d="${path} Z" fill="${palette.waterFill}" stroke="${palette.waterStroke}" stroke-width="0.8" opacity="0.85"/>`;
      }
      return `<path d="${path} Z" fill="${palette.parkFill}" stroke="${palette.parkStroke}" stroke-width="0.6" opacity="0.72"/>`;
    })
    .join("\n");
  const markers = request.markers
    .map((marker, index) => {
      const point = project({ lat: marker.lat, lng: marker.lng });
      const label = marker.label ?? String(index + 1);
      return `<g><circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="12" fill="${palette.markerFill}" stroke="${palette.markerStroke}" stroke-width="3"/><text x="${point.x.toFixed(1)}" y="${(point.y + 4).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="${palette.markerStroke}">${xmlEscape(String(index + 1))}</text><text x="${(point.x + 16).toFixed(1)}" y="${(point.y - 14).toFixed(1)}" font-size="14" font-weight="700" fill="${palette.text}" paint-order="stroke" stroke="${palette.textHalo}" stroke-width="5">${xmlEscape(label)}</text></g>`;
    })
    .join("\n");
  const title = request.title
    ? `<text x="28" y="48" font-size="32" font-weight="800" fill="${palette.text}" paint-order="stroke" stroke="${palette.textHalo}" stroke-width="7">${xmlEscape(request.title)}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="${palette.background}"/>
${featureMarkup}
${markers}
${title}
<text x="${width - 24}" y="${height - 18}" text-anchor="end" font-size="12" fill="${palette.attribution}">${ATTRIBUTION}</text>
</svg>`;
}

function renderPngBase64(
  request: ZeroMapsOsmRenderRequest,
  bbox: BoundingBox,
  features: readonly OsmFeature[],
): string {
  const svg = renderSvg(request, bbox, features);
  return Buffer.from(new Resvg(svg).render().asPng()).toString("base64");
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
