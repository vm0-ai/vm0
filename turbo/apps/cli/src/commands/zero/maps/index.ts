import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";
import { callZeroMaps, type ZeroMapsResponse } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

const TRAVEL_MODES = ["driving", "walking", "bicycling", "transit"] as const;
const PLACE_DETAIL_FIELDSETS = ["essentials", "pro"] as const;

type TravelMode = (typeof TRAVEL_MODES)[number];
type PlaceDetailFieldset = (typeof PLACE_DETAIL_FIELDSETS)[number];

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
}

interface PlacesDetailsOptions extends JsonOption {
  placeId: string;
  fields: PlaceDetailFieldset;
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

function parseTravelMode(value: string): TravelMode {
  if (TRAVEL_MODES.includes(value as TravelMode)) {
    return value as TravelMode;
  }
  throw new InvalidArgumentError(
    `mode must be one of: ${TRAVEL_MODES.join(", ")}`,
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

function renderMapsResponse(label: string, response: ZeroMapsResponse): void {
  console.log(chalk.green(`✓ ${label}`));
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

  const result = response.result ?? response;
  console.log(JSON.stringify(result, null, 2));
}

async function runMapsRequest(
  label: string,
  endpoint:
    | "geocode"
    | "reverse-geocode"
    | "directions"
    | "places/search"
    | "places/details",
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
    "Field set: essentials or pro",
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
  .addHelpText(
    "after",
    `
Examples:
  Geocode address:     zero maps geocode --address "1 Infinite Loop, Cupertino" --json
  Get route:           zero maps directions --origin "SFO" --destination "Mountain View" --mode driving --json
  Search places:       zero maps places search --query "coffee near Union Square SF" --limit 5 --json
  Place details:       zero maps places details --place-id <id> --fields essentials --json

Notes:
  - Authenticates via ZERO_TOKEN (requires maps:read capability) or a CLI token
  - Google Maps calls and credit billing happen on the vm0 API server
  - Use --fields essentials for place details unless pro fields are required`,
  );
