import type {
  MapsDirectionsRequest,
  MapsGeocodeRequest,
  MapsPlacesDetailsRequest,
  MapsPlacesSearchRequest,
  MapsResponse,
  MapsReverseGeocodeRequest,
} from "@okouai/api-contracts/contracts/maps";
import { command } from "ccstate";

import type { AuthContext } from "../../types/auth";
import { env } from "../../lib/env";
import { safeJsonParse } from "../utils";
import {
  checkManagedCredits$,
  recordManagedUsage$,
  type ManagedUsageErrorResponse,
} from "./managed-usage.service";

const PROVIDER = "google-maps";
const USAGE_KIND = "maps";
const GEOCODING_CATEGORY = "geocoding";
const DIRECTIONS_CATEGORY = "routes.directions";
const DIRECTIONS_ADVANCED_CATEGORY = "routes.directions.advanced";
const PLACES_TEXT_SEARCH_PRO_CATEGORY = "places.text_search.pro";
const PLACES_TEXT_SEARCH_ENTERPRISE_CATEGORY = "places.text_search.enterprise";
const PLACES_DETAILS_ESSENTIALS_CATEGORY = "places.details.essentials";
const PLACES_DETAILS_PRO_CATEGORY = "places.details.pro";
const PLACES_DETAILS_ENTERPRISE_CATEGORY = "places.details.enterprise";

const GOOGLE_GEOCODING_URL =
  "https://maps.googleapis.com/maps/api/geocode/json";
const GOOGLE_DIRECTIONS_URL =
  "https://maps.googleapis.com/maps/api/directions/json";
const GOOGLE_PLACES_SEARCH_TEXT_URL =
  "https://places.googleapis.com/v1/places:searchText";
const GOOGLE_PLACES_DETAILS_BASE_URL = "https://places.googleapis.com/v1/";

const PLACE_SEARCH_PRO_FIELD_MASK =
  "places.id,places.name,places.displayName,places.formattedAddress,places.location,places.types";
const PLACE_SEARCH_ENTERPRISE_FIELD_MASK = `${PLACE_SEARCH_PRO_FIELD_MASK},places.googleMapsUri,places.priceLevel,places.priceRange`;
const PLACE_DETAILS_ESSENTIALS_FIELD_MASK =
  "id,name,formattedAddress,location,types,viewport,plusCode";
const PLACE_DETAILS_PRO_FIELD_MASK =
  "id,name,displayName,formattedAddress,location,types,viewport,plusCode,googleMapsUri,businessStatus";
const PLACE_DETAILS_ENTERPRISE_FIELD_MASK = `${PLACE_DETAILS_PRO_FIELD_MASK},priceLevel,priceRange,rating,userRatingCount,regularOpeningHours,currentOpeningHours,websiteUri,nationalPhoneNumber`;
const DEFAULT_LOCATION_BIAS_RADIUS_METERS = 50_000;

type ErrorStatus = 400 | 402 | 502 | 503;
type PlaceSearchFieldset = MapsPlacesSearchRequest["fields"];
type PlaceDetailFieldset = MapsPlacesDetailsRequest["fields"];

export interface MapsErrorResponse {
  readonly status: ErrorStatus;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

interface MapsUsageArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string;
  readonly provider?: string;
  readonly category: string;
}

type MapsCommandResponse =
  | { readonly status: 200; readonly body: MapsResponse }
  | MapsErrorResponse
  | ManagedUsageErrorResponse;

interface CompleteGoogleMapsResultArgs {
  readonly operation: MapsResponse["operation"];
  readonly result: unknown | MapsErrorResponse;
  readonly billingCategory: string;
  readonly validateLegacyGoogleStatus?: boolean;
  readonly recordUsage: () => Promise<number>;
}

interface MapsCreditCheckArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly provider?: string;
  readonly category: string;
}

interface AuthedMapsArgs<TBody> {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: TBody;
}

interface LatLng {
  readonly latitude: number;
  readonly longitude: number;
}

interface LocationBias {
  readonly circle: {
    readonly center: LatLng;
    readonly radius: number;
  };
}

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function badRequest(message: string): MapsErrorResponse {
  return { status: 400, body: errorBody(message, "BAD_REQUEST") };
}

function badGateway(message: string, code = "GOOGLE_MAPS_ERROR") {
  return { status: 502 as const, body: errorBody(message, code) };
}

function serviceUnavailable(message: string, code: string): MapsErrorResponse {
  return { status: 503, body: errorBody(message, code) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMapsErrorResponse(value: unknown): value is MapsErrorResponse {
  return (
    isRecord(value) &&
    typeof value.status === "number" &&
    isRecord(value.body) &&
    isRecord(value.body.error)
  );
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  const parsed = safeJsonParse(text);
  return parsed === undefined ? text : parsed;
}

function googleErrorMessage(body: unknown): string {
  if (isRecord(body)) {
    const error = body.error;
    if (isRecord(error) && typeof error.message === "string") {
      return error.message;
    }
    if (typeof body.error_message === "string") {
      return body.error_message;
    }
    if (typeof body.status === "string") {
      return `Google Maps request failed with status ${body.status}`;
    }
  }
  if (typeof body === "string" && body.trim()) {
    return body;
  }
  return "Google Maps request failed";
}

async function fetchGoogleJson(
  url: URL,
  init: RequestInit,
): Promise<unknown | MapsErrorResponse> {
  const response = await fetch(url, init);
  const body = await readResponseBody(response);
  if (!response.ok) {
    return badGateway(googleErrorMessage(body));
  }
  return body;
}

function legacyMapsFailure(body: unknown): MapsErrorResponse | null {
  if (!isRecord(body) || typeof body.status !== "string") {
    return null;
  }
  if (body.status === "OK" || body.status === "ZERO_RESULTS") {
    return null;
  }
  return badGateway(googleErrorMessage(body), body.status);
}

function withApiKey(url: string, apiKey: string): URL {
  const target = new URL(url);
  target.searchParams.set("key", apiKey);
  return target;
}

function maybeSetParam(
  params: URLSearchParams,
  name: string,
  value: string | undefined,
): void {
  if (value !== undefined) {
    params.set(name, value);
  }
}

function normalizeDepartureTime(value: string): string {
  if (value === "now") {
    return value;
  }
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return String(Math.floor(parsed / 1000));
  }
  return value;
}

function parseLocation(value: string): LatLng | null {
  const [latRaw, lngRaw, extra] = value.split(",");
  if (extra !== undefined || latRaw === undefined || lngRaw === undefined) {
    return null;
  }
  const latitude = Number(latRaw.trim());
  const longitude = Number(lngRaw.trim());
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return { latitude, longitude };
}

function locationBiasFromOptions(
  location: string | undefined,
  radius: number | undefined,
): LocationBias | MapsErrorResponse | undefined {
  if (radius !== undefined && location === undefined) {
    return badRequest("location is required when radius is provided");
  }
  if (location === undefined) {
    return undefined;
  }

  const center = parseLocation(location);
  if (!center) {
    return badRequest("location must be formatted as lat,lng");
  }

  return {
    circle: {
      center,
      radius: radius ?? DEFAULT_LOCATION_BIAS_RADIUS_METERS,
    },
  };
}

function placeSearchFieldMask(fields: PlaceSearchFieldset): string {
  return fields === "enterprise"
    ? PLACE_SEARCH_ENTERPRISE_FIELD_MASK
    : PLACE_SEARCH_PRO_FIELD_MASK;
}

function placeSearchBillingCategory(fields: PlaceSearchFieldset): string {
  return fields === "enterprise"
    ? PLACES_TEXT_SEARCH_ENTERPRISE_CATEGORY
    : PLACES_TEXT_SEARCH_PRO_CATEGORY;
}

function placeDetailsFieldMask(fields: PlaceDetailFieldset): string {
  if (fields === "enterprise") {
    return PLACE_DETAILS_ENTERPRISE_FIELD_MASK;
  }
  return fields === "pro"
    ? PLACE_DETAILS_PRO_FIELD_MASK
    : PLACE_DETAILS_ESSENTIALS_FIELD_MASK;
}

function placeDetailsBillingCategory(fields: PlaceDetailFieldset): string {
  if (fields === "enterprise") {
    return PLACES_DETAILS_ENTERPRISE_CATEGORY;
  }
  return fields === "pro"
    ? PLACES_DETAILS_PRO_CATEGORY
    : PLACES_DETAILS_ESSENTIALS_CATEGORY;
}

function runIdForUsage(auth: AuthContext): string | undefined {
  return auth.tokenType === "agent" || auth.tokenType === "sandbox"
    ? auth.runId
    : undefined;
}

export const checkMapsCredits$ = command(
  async (
    { set },
    args: MapsCreditCheckArgs,
    signal: AbortSignal,
  ): Promise<ManagedUsageErrorResponse | null> => {
    const provider = args.provider ?? PROVIDER;
    return await set(
      checkManagedCredits$,
      {
        orgId: args.orgId,
        userId: args.userId,
        resource: {
          kind: USAGE_KIND,
          provider,
          category: args.category,
        },
        label: "Okou Maps",
      },
      signal,
    );
  },
);

export const recordMapsUsage$ = command(
  async (
    { set },
    args: MapsUsageArgs,
    signal: AbortSignal,
  ): Promise<number> => {
    return await set(
      recordManagedUsage$,
      {
        actor: {
          orgId: args.orgId,
          userId: args.userId,
          ...(args.runId ? { runId: args.runId } : {}),
        },
        resource: {
          kind: USAGE_KIND,
          provider: args.provider ?? PROVIDER,
          category: args.category,
        },
        label: "maps",
      },
      signal,
    );
  },
);

async function completeGoogleMapsResult(
  args: CompleteGoogleMapsResultArgs,
): Promise<MapsCommandResponse> {
  if (isMapsErrorResponse(args.result)) {
    return args.result;
  }
  if (args.validateLegacyGoogleStatus) {
    const failure = legacyMapsFailure(args.result);
    if (failure) {
      return failure;
    }
  }

  const creditsCharged = await args.recordUsage();
  const body: MapsResponse = {
    operation: args.operation,
    provider: PROVIDER,
    creditsCharged,
    billingCategory: args.billingCategory,
    billingQuantity: 1,
    result: args.result,
  };
  return { status: 200 as const, body };
}

export const mapsGeocode$ = command(
  async (
    { set },
    args: AuthedMapsArgs<MapsGeocodeRequest>,
    signal: AbortSignal,
  ) => {
    const apiKey = env("OKOU_MAPS_GOOGLE_MAPS_TOKEN");
    if (!apiKey) {
      return serviceUnavailable(
        "Okou Maps Google Maps provider is not configured",
        "NOT_CONFIGURED",
      );
    }

    const creditError = await set(
      checkMapsCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        category: GEOCODING_CATEGORY,
      },
      signal,
    );
    if (creditError) {
      return creditError;
    }

    const url = withApiKey(GOOGLE_GEOCODING_URL, apiKey);
    url.searchParams.set("address", args.body.address);
    maybeSetParam(url.searchParams, "region", args.body.region);
    const result = await fetchGoogleJson(url, { signal });
    return completeGoogleMapsResult({
      operation: "geocode",
      result,
      billingCategory: GEOCODING_CATEGORY,
      validateLegacyGoogleStatus: true,
      recordUsage: () => {
        return set(
          recordMapsUsage$,
          {
            orgId: args.auth.orgId,
            userId: args.auth.userId,
            runId: runIdForUsage(args.auth),
            category: GEOCODING_CATEGORY,
          },
          signal,
        );
      },
    });
  },
);

export const mapsReverseGeocode$ = command(
  async (
    { set },
    args: AuthedMapsArgs<MapsReverseGeocodeRequest>,
    signal: AbortSignal,
  ) => {
    const apiKey = env("OKOU_MAPS_GOOGLE_MAPS_TOKEN");
    if (!apiKey) {
      return serviceUnavailable(
        "Okou Maps Google Maps provider is not configured",
        "NOT_CONFIGURED",
      );
    }

    const creditError = await set(
      checkMapsCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        category: GEOCODING_CATEGORY,
      },
      signal,
    );
    if (creditError) {
      return creditError;
    }

    const url = withApiKey(GOOGLE_GEOCODING_URL, apiKey);
    url.searchParams.set("latlng", `${args.body.lat},${args.body.lng}`);
    const result = await fetchGoogleJson(url, { signal });
    return completeGoogleMapsResult({
      operation: "reverse-geocode",
      result,
      billingCategory: GEOCODING_CATEGORY,
      validateLegacyGoogleStatus: true,
      recordUsage: () => {
        return set(
          recordMapsUsage$,
          {
            orgId: args.auth.orgId,
            userId: args.auth.userId,
            runId: runIdForUsage(args.auth),
            category: GEOCODING_CATEGORY,
          },
          signal,
        );
      },
    });
  },
);

export const mapsDirections$ = command(
  async (
    { set },
    args: AuthedMapsArgs<MapsDirectionsRequest>,
    signal: AbortSignal,
  ) => {
    const apiKey = env("OKOU_MAPS_GOOGLE_MAPS_TOKEN");
    if (!apiKey) {
      return serviceUnavailable(
        "Okou Maps Google Maps provider is not configured",
        "NOT_CONFIGURED",
      );
    }

    const billingCategory =
      args.body.departureTime === undefined
        ? DIRECTIONS_CATEGORY
        : DIRECTIONS_ADVANCED_CATEGORY;
    const creditError = await set(
      checkMapsCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        category: billingCategory,
      },
      signal,
    );
    if (creditError) {
      return creditError;
    }

    const url = withApiKey(GOOGLE_DIRECTIONS_URL, apiKey);
    url.searchParams.set("origin", args.body.origin);
    url.searchParams.set("destination", args.body.destination);
    url.searchParams.set("mode", args.body.mode);
    if (args.body.departureTime !== undefined) {
      url.searchParams.set(
        "departure_time",
        normalizeDepartureTime(args.body.departureTime),
      );
    }
    const result = await fetchGoogleJson(url, { signal });
    return completeGoogleMapsResult({
      operation: "directions",
      result,
      billingCategory,
      validateLegacyGoogleStatus: true,
      recordUsage: () => {
        return set(
          recordMapsUsage$,
          {
            orgId: args.auth.orgId,
            userId: args.auth.userId,
            runId: runIdForUsage(args.auth),
            category: billingCategory,
          },
          signal,
        );
      },
    });
  },
);

export const mapsPlacesSearch$ = command(
  async (
    { set },
    args: AuthedMapsArgs<MapsPlacesSearchRequest>,
    signal: AbortSignal,
  ) => {
    const apiKey = env("OKOU_MAPS_GOOGLE_MAPS_TOKEN");
    if (!apiKey) {
      return serviceUnavailable(
        "Okou Maps Google Maps provider is not configured",
        "NOT_CONFIGURED",
      );
    }

    const locationBias = locationBiasFromOptions(
      args.body.location,
      args.body.radius,
    );
    if (isMapsErrorResponse(locationBias)) {
      return locationBias;
    }

    const billingCategory = placeSearchBillingCategory(args.body.fields);
    const creditError = await set(
      checkMapsCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        category: billingCategory,
      },
      signal,
    );
    if (creditError) {
      return creditError;
    }

    const requestBody = {
      textQuery: args.body.query,
      maxResultCount: args.body.limit,
      ...(args.body.region ? { regionCode: args.body.region } : {}),
      ...(locationBias ? { locationBias } : {}),
    };
    const result = await fetchGoogleJson(
      new URL(GOOGLE_PLACES_SEARCH_TEXT_URL),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": placeSearchFieldMask(args.body.fields),
        },
        body: JSON.stringify(requestBody),
        signal,
      },
    );
    return completeGoogleMapsResult({
      operation: "places.search",
      result,
      billingCategory,
      recordUsage: () => {
        return set(
          recordMapsUsage$,
          {
            orgId: args.auth.orgId,
            userId: args.auth.userId,
            runId: runIdForUsage(args.auth),
            category: billingCategory,
          },
          signal,
        );
      },
    });
  },
);

export const mapsPlacesDetails$ = command(
  async (
    { set },
    args: AuthedMapsArgs<MapsPlacesDetailsRequest>,
    signal: AbortSignal,
  ) => {
    const apiKey = env("OKOU_MAPS_GOOGLE_MAPS_TOKEN");
    if (!apiKey) {
      return serviceUnavailable(
        "Okou Maps Google Maps provider is not configured",
        "NOT_CONFIGURED",
      );
    }

    const billingCategory = placeDetailsBillingCategory(args.body.fields);
    const creditError = await set(
      checkMapsCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        category: billingCategory,
      },
      signal,
    );
    if (creditError) {
      return creditError;
    }

    const placeId = args.body.placeId.replace(/^places\//, "");
    const result = await fetchGoogleJson(
      new URL(
        `places/${encodeURIComponent(placeId)}`,
        GOOGLE_PLACES_DETAILS_BASE_URL,
      ),
      {
        headers: {
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": placeDetailsFieldMask(args.body.fields),
        },
        signal,
      },
    );
    return completeGoogleMapsResult({
      operation: "places.details",
      result,
      billingCategory,
      recordUsage: () => {
        return set(
          recordMapsUsage$,
          {
            orgId: args.auth.orgId,
            userId: args.auth.userId,
            runId: runIdForUsage(args.auth),
            category: billingCategory,
          },
          signal,
        );
      },
    });
  },
);
