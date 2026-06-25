import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";
import { callZeroMaps, type ZeroMapsResponse } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

const TRAVEL_MODES = ["driving", "walking", "bicycling", "transit"] as const;
const PLACE_SEARCH_FIELDSETS = ["pro", "enterprise"] as const;
const PLACE_DETAIL_FIELDSETS = ["essentials", "pro", "enterprise"] as const;
const OSM_LAYERS = ["roads", "buildings", "water", "parks"] as const;
const OSM_STYLES = ["standard", "guide"] as const;

type TravelMode = (typeof TRAVEL_MODES)[number];
type PlaceSearchFieldset = (typeof PLACE_SEARCH_FIELDSETS)[number];
type PlaceDetailFieldset = (typeof PLACE_DETAIL_FIELDSETS)[number];
type OsmLayer = (typeof OSM_LAYERS)[number];
type OsmStyle = (typeof OSM_STYLES)[number];

interface JsonOption {
  json?: boolean;
}

interface GeocodeOptions extends JsonOption {
  address: string;
  region?: string;
}

interface ReverseGeocodeOptions extends JsonOption {
  lat: number;
  lng: number;
}

interface DirectionsOptions extends JsonOption {
  origin: string;
  destination: string;
  mode: TravelMode;
  departureTime?: string;
}

interface PlacesSearchOptions extends JsonOption {
  query: string;
  location?: string;
  radius?: number;
  limit: number;
  region?: string;
  fields: PlaceSearchFieldset;
}

interface PlacesDetailsOptions extends JsonOption {
  placeId: string;
  fields: PlaceDetailFieldset;
}

interface BBox {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

interface OsmMarker extends LatLng {
  readonly label?: string;
}

interface OsmAreaOptions extends JsonOption {
  bbox?: BBox;
  center?: LatLng;
  radius?: number;
  layers: readonly OsmLayer[];
  output?: string;
}

interface OsmRenderOptions extends OsmAreaOptions {
  width: number;
  height: number;
  style: OsmStyle;
  title?: string;
  marker: readonly OsmMarker[];
  output: string;
}

function parseLatitude(value: string): number {
  const latitude = Number(value);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new InvalidArgumentError("latitude must be a number from -90 to 90");
  }
  return latitude;
}

function parseLongitude(value: string): number {
  const longitude = Number(value);
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new InvalidArgumentError(
      "longitude must be a number from -180 to 180",
    );
  }
  return longitude;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("value must be a positive integer");
  }
  return parsed;
}

function parseLimit(value: string): number {
  const limit = parsePositiveInteger(value);
  if (limit > 20) {
    throw new InvalidArgumentError("limit must be between 1 and 20");
  }
  return limit;
}

function parseIntegerInRange(value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new InvalidArgumentError(
      `value must be an integer from ${min} to ${max}`,
    );
  }
  return parsed;
}

function parseTravelMode(value: string): TravelMode {
  if (TRAVEL_MODES.includes(value as TravelMode)) {
    return value as TravelMode;
  }
  throw new InvalidArgumentError(
    `mode must be one of: ${TRAVEL_MODES.join(", ")}`,
  );
}

function parsePlaceSearchFields(value: string): PlaceSearchFieldset {
  if (PLACE_SEARCH_FIELDSETS.includes(value as PlaceSearchFieldset)) {
    return value as PlaceSearchFieldset;
  }
  throw new InvalidArgumentError(
    `fields must be one of: ${PLACE_SEARCH_FIELDSETS.join(", ")}`,
  );
}

function parsePlaceDetailFields(value: string): PlaceDetailFieldset {
  if (PLACE_DETAIL_FIELDSETS.includes(value as PlaceDetailFieldset)) {
    return value as PlaceDetailFieldset;
  }
  throw new InvalidArgumentError(
    `fields must be one of: ${PLACE_DETAIL_FIELDSETS.join(", ")}`,
  );
}

function parseBBox(value: string): BBox {
  const parts = value.split(",").map((part) => {
    return part.trim();
  });
  if (parts.length !== 4) {
    throw new InvalidArgumentError("bbox must be west,south,east,north");
  }
  const [westRaw, southRaw, eastRaw, northRaw] = parts;
  if (!westRaw || !southRaw || !eastRaw || !northRaw) {
    throw new InvalidArgumentError("bbox must be west,south,east,north");
  }
  const bbox = {
    west: parseLongitude(westRaw),
    south: parseLatitude(southRaw),
    east: parseLongitude(eastRaw),
    north: parseLatitude(northRaw),
  };
  if (bbox.east <= bbox.west || bbox.north <= bbox.south) {
    throw new InvalidArgumentError(
      "bbox east/north must be greater than west/south",
    );
  }
  return bbox;
}

function parseLatLng(value: string): LatLng {
  const parts = value.split(",").map((part) => {
    return part.trim();
  });
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new InvalidArgumentError("coordinates must be lat,lng");
  }
  return {
    lat: parseLatitude(parts[0]),
    lng: parseLongitude(parts[1]),
  };
}

function parseOsmLayers(value: string): readonly OsmLayer[] {
  const layers = [
    ...new Set(
      value
        .split(",")
        .map((layer) => {
          return layer.trim();
        })
        .filter(Boolean),
    ),
  ];
  if (layers.length === 0) {
    throw new InvalidArgumentError("layers must include at least one value");
  }
  const invalid = layers.find((layer) => {
    return !OSM_LAYERS.includes(layer as OsmLayer);
  });
  if (invalid) {
    throw new InvalidArgumentError(
      `layers must be drawn from: ${OSM_LAYERS.join(", ")}`,
    );
  }
  return layers as readonly OsmLayer[];
}

function parseOsmStyle(value: string): OsmStyle {
  if (OSM_STYLES.includes(value as OsmStyle)) {
    return value as OsmStyle;
  }
  throw new InvalidArgumentError(
    `style must be one of: ${OSM_STYLES.join(", ")}`,
  );
}

function parseOsmMarker(value: string): OsmMarker {
  const [latRaw, lngRaw, ...labelParts] = value.split(",");
  if (!latRaw?.trim() || !lngRaw?.trim()) {
    throw new InvalidArgumentError("marker must be lat,lng or lat,lng,label");
  }
  const label = labelParts.join(",").trim();
  return {
    lat: parseLatitude(latRaw.trim()),
    lng: parseLongitude(lngRaw.trim()),
    ...(label ? { label } : {}),
  };
}

function collectOsmMarker(
  value: string,
  previous: readonly OsmMarker[],
): readonly OsmMarker[] {
  return [...previous, parseOsmMarker(value)];
}

function osmAreaPayload(options: OsmAreaOptions): Record<string, unknown> {
  const hasBbox = options.bbox !== undefined;
  const hasCenterRadius =
    options.center !== undefined && options.radius !== undefined;
  if (hasBbox === hasCenterRadius) {
    throw new Error("Provide either --bbox or --center with --radius");
  }
  return {
    ...(options.bbox ? { bbox: options.bbox } : {}),
    ...(options.center ? { center: options.center } : {}),
    ...(options.radius !== undefined ? { radiusMeters: options.radius } : {}),
    layers: options.layers,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultRecord(response: ZeroMapsResponse): Record<string, unknown> {
  if (!isRecord(response.result)) {
    throw new Error("Zero Maps response did not include an object result");
  }
  return response.result;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const field = value[key];
  return typeof field === "number" ? field : undefined;
}

async function writeOutputFile(
  outputPath: string,
  content: string | Buffer,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content);
}

async function writeOsmGeoJson(
  outputPath: string,
  response: ZeroMapsResponse,
): Promise<void> {
  const result = resultRecord(response);
  if (!("geojson" in result)) {
    throw new Error("Zero Maps OSM download response did not include geojson");
  }
  await writeOutputFile(
    outputPath,
    `${JSON.stringify(result.geojson, null, 2)}\n`,
  );
}

async function writeOsmPng(
  outputPath: string,
  response: ZeroMapsResponse,
): Promise<void> {
  const result = resultRecord(response);
  const image = result.image;
  if (!isRecord(image) || typeof image.base64 !== "string") {
    throw new Error(
      "Zero Maps OSM render response did not include a PNG image",
    );
  }
  await writeOutputFile(outputPath, Buffer.from(image.base64, "base64"));
}

function renderMapsMetadata(response: ZeroMapsResponse): void {
  if (response.provider) {
    console.log(chalk.dim(`  Provider: ${response.provider}`));
  }
  if (response.billingCategory) {
    console.log(chalk.dim(`  Billing category: ${response.billingCategory}`));
  }
  if (response.billingQuantity !== undefined) {
    console.log(chalk.dim(`  Billing quantity: ${response.billingQuantity}`));
  }
  if (response.creditsCharged !== undefined) {
    console.log(chalk.dim(`  Credits charged: ${response.creditsCharged}`));
  }
}

function renderMapsResponse(label: string, response: ZeroMapsResponse): void {
  console.log(chalk.green(`✓ ${label}`));
  renderMapsMetadata(response);

  const result = response.result ?? response;
  console.log(JSON.stringify(result, null, 2));
}

function renderOsmFileResponse(
  label: string,
  response: ZeroMapsResponse,
  outputPath: string,
): void {
  console.log(chalk.green(`✓ ${label}`));
  renderMapsMetadata(response);

  const result = isRecord(response.result) ? response.result : {};
  const featureCount = numberField(result, "featureCount");
  const attribution = stringField(result, "attribution");
  if (featureCount !== undefined) {
    console.log(chalk.dim(`  Features: ${featureCount}`));
  }
  if (attribution) {
    console.log(chalk.dim(`  Attribution: ${attribution}`));
  }
  console.log(chalk.dim(`  Output: ${outputPath}`));
}

async function runMapsRequest(
  label: string,
  endpoint:
    | "geocode"
    | "reverse-geocode"
    | "directions"
    | "places/search"
    | "places/details"
    | "osm/download"
    | "osm/render",
  payload: Record<string, unknown>,
  options: JsonOption,
): Promise<void> {
  const response = await callZeroMaps(endpoint, payload);

  if (options.json) {
    console.log(JSON.stringify(response));
    return;
  }

  renderMapsResponse(label, response);
}

const geocodeCommand = new Command()
  .name("geocode")
  .description("Convert an address into coordinates")
  .requiredOption("--address <address>", "Address to geocode")
  .option("--region <code>", "Optional region bias, such as US or CN")
  .option("--json", "Print the raw maps response as JSON")
  .action(
    withErrorHandler(async (options: GeocodeOptions) => {
      await runMapsRequest(
        "Geocode completed",
        "geocode",
        { address: options.address, region: options.region },
        options,
      );
    }),
  );

const reverseGeocodeCommand = new Command()
  .name("reverse-geocode")
  .description("Convert coordinates into an address")
  .requiredOption("--lat <number>", "Latitude", parseLatitude)
  .requiredOption("--lng <number>", "Longitude", parseLongitude)
  .option("--json", "Print the raw maps response as JSON")
  .action(
    withErrorHandler(async (options: ReverseGeocodeOptions) => {
      await runMapsRequest(
        "Reverse geocode completed",
        "reverse-geocode",
        { lat: options.lat, lng: options.lng },
        options,
      );
    }),
  );

const directionsCommand = new Command()
  .name("directions")
  .description("Get a route between two places")
  .requiredOption(
    "--origin <place>",
    "Origin address, coordinates, or place ID",
  )
  .requiredOption(
    "--destination <place>",
    "Destination address, coordinates, or place ID",
  )
  .option(
    "--mode <mode>",
    "Travel mode: driving, walking, bicycling, or transit",
    parseTravelMode,
    "driving",
  )
  .option("--departure-time <time>", "ISO departure time or provider keyword")
  .option("--json", "Print the raw maps response as JSON")
  .action(
    withErrorHandler(async (options: DirectionsOptions) => {
      await runMapsRequest(
        "Directions completed",
        "directions",
        {
          origin: options.origin,
          destination: options.destination,
          mode: options.mode,
          departureTime: options.departureTime,
        },
        options,
      );
    }),
  );

const placesSearchCommand = new Command()
  .name("search")
  .description("Search for places")
  .requiredOption("--query <query>", "Place search query")
  .option("--location <lat,lng>", "Optional location bias")
  .option(
    "--radius <meters>",
    "Optional search radius in meters",
    parsePositiveInteger,
  )
  .option(
    "--limit <n>",
    "Maximum places to return, from 1 to 20",
    parseLimit,
    5,
  )
  .option("--region <code>", "Optional region bias, such as US or CN")
  .option(
    "--fields <fields>",
    "Field set: pro or enterprise",
    parsePlaceSearchFields,
    "pro",
  )
  .option("--json", "Print the raw maps response as JSON")
  .action(
    withErrorHandler(async (options: PlacesSearchOptions) => {
      await runMapsRequest(
        "Places search completed",
        "places/search",
        {
          query: options.query,
          location: options.location,
          radius: options.radius,
          limit: options.limit,
          region: options.region,
          fields: options.fields,
        },
        options,
      );
    }),
  );

const placesDetailsCommand = new Command()
  .name("details")
  .description("Get details for a place")
  .requiredOption("--place-id <id>", "Provider place ID")
  .option(
    "--fields <fields>",
    "Field set: essentials, pro, or enterprise",
    parsePlaceDetailFields,
    "essentials",
  )
  .option("--json", "Print the raw maps response as JSON")
  .action(
    withErrorHandler(async (options: PlacesDetailsOptions) => {
      await runMapsRequest(
        "Place details completed",
        "places/details",
        { placeId: options.placeId, fields: options.fields },
        options,
      );
    }),
  );

const osmDownloadCommand = new Command()
  .name("download")
  .description("Download OpenStreetMap vector features as GeoJSON")
  .option(
    "--bbox <west,south,east,north>",
    "Bounding box in WGS84 coordinates",
    parseBBox,
  )
  .option(
    "--center <lat,lng>",
    "Center point in WGS84 coordinates",
    parseLatLng,
  )
  .option(
    "--radius <meters>",
    "Radius in meters when using --center",
    parsePositiveInteger,
  )
  .option(
    "--layers <layers>",
    "Comma-separated layers: roads, buildings, water, parks",
    parseOsmLayers,
    OSM_LAYERS,
  )
  .option("--output <path>", "Write GeoJSON to a file")
  .option("--json", "Print the raw maps response as JSON")
  .action(
    withErrorHandler(async (options: OsmAreaOptions) => {
      const response = await callZeroMaps(
        "osm/download",
        osmAreaPayload(options),
      );
      if (options.output) {
        await writeOsmGeoJson(options.output, response);
      }
      if (options.json) {
        console.log(JSON.stringify(response));
        return;
      }
      if (options.output) {
        renderOsmFileResponse(
          "OSM download completed",
          response,
          options.output,
        );
        return;
      }
      renderMapsResponse("OSM download completed", response);
    }),
  );

const osmRenderCommand = new Command()
  .name("render")
  .description("Render OpenStreetMap vector features to PNG")
  .option(
    "--bbox <west,south,east,north>",
    "Bounding box in WGS84 coordinates",
    parseBBox,
  )
  .option(
    "--center <lat,lng>",
    "Center point in WGS84 coordinates",
    parseLatLng,
  )
  .option(
    "--radius <meters>",
    "Radius in meters when using --center",
    parsePositiveInteger,
  )
  .option(
    "--layers <layers>",
    "Comma-separated layers: roads, buildings, water, parks",
    parseOsmLayers,
    OSM_LAYERS,
  )
  .option(
    "--width <px>",
    "PNG width in pixels, from 320 to 2048",
    (value) => {
      return parseIntegerInRange(value, 320, 2_048);
    },
    1_536,
  )
  .option(
    "--height <px>",
    "PNG height in pixels, from 240 to 2048",
    (value) => {
      return parseIntegerInRange(value, 240, 2_048);
    },
    1_024,
  )
  .option(
    "--style <style>",
    "Render style: standard or guide",
    parseOsmStyle,
    "standard",
  )
  .option("--title <text>", "Optional title drawn onto the PNG")
  .option(
    "--marker <lat,lng[,label]>",
    "Marker to draw; repeat for multiple markers",
    collectOsmMarker,
    [],
  )
  .requiredOption("--output <path>", "Write PNG to a file")
  .option("--json", "Print the raw maps response as JSON")
  .action(
    withErrorHandler(async (options: OsmRenderOptions) => {
      const response = await callZeroMaps("osm/render", {
        ...osmAreaPayload(options),
        width: options.width,
        height: options.height,
        style: options.style,
        title: options.title,
        markers: options.marker,
      });
      await writeOsmPng(options.output, response);
      if (options.json) {
        console.log(JSON.stringify(response));
        return;
      }
      renderOsmFileResponse("OSM render completed", response, options.output);
    }),
  );

const osmCommand = new Command()
  .name("osm")
  .description("Download and render OpenStreetMap data")
  .addCommand(osmDownloadCommand)
  .addCommand(osmRenderCommand);

const placesCommand = new Command()
  .name("places")
  .description("Search places and fetch place details")
  .addCommand(placesSearchCommand)
  .addCommand(placesDetailsCommand);

export const zeroMapsCommand = new Command()
  .name("maps")
  .description("Use managed zero maps services")
  .addCommand(geocodeCommand)
  .addCommand(reverseGeocodeCommand)
  .addCommand(directionsCommand)
  .addCommand(placesCommand)
  .addCommand(osmCommand)
  .addHelpText(
    "after",
    `
Examples:
  Geocode address:     zero maps geocode --address "1 Infinite Loop, Cupertino" --json
  Get route:           zero maps directions --origin "SFO" --destination "Mountain View" --mode driving --json
  Search places:       zero maps places search --query "coffee near Union Square SF" --limit 5 --json
  Enterprise search:   zero maps places search --query "restaurants in SoMa" --fields enterprise --json
  Place details:       zero maps places details --place-id <id> --fields essentials --json
  Enterprise details:  zero maps places details --place-id <id> --fields enterprise --json
  Download OSM data:    zero maps osm download --bbox -122.43,37.76,-122.40,37.79 --output map.geojson
  Render OSM PNG:       zero maps osm render --center 37.7749,-122.4194 --radius 1200 --output map.png

Notes:
  - Authenticates via ZERO_TOKEN (requires maps:read capability) or a CLI token
  - Google Maps and OpenStreetMap calls and credit billing happen on the vm0 API server
  - Use --fields essentials for place details unless paid fields are required`,
  );
