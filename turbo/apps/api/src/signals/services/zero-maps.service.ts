import { randomUUID } from "node:crypto";

import type {
  ZeroMapsDirectionsRequest,
  ZeroMapsGeocodeRequest,
  ZeroMapsPlacesDetailsRequest,
  ZeroMapsPlacesSearchRequest,
  ZeroMapsResponse,
  ZeroMapsReverseGeocodeRequest,
} from "@vm0/api-contracts/contracts/zero-maps";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import type { AuthContext } from "../../types/auth";
import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { safeJsonParse } from "../utils";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";

const PROVIDER = "google-maps";
const USAGE_KIND = "maps";
const GEOCODING_CATEGORY = "geocoding";
const DIRECTIONS_CATEGORY = "routes.directions";
const DIRECTIONS_ADVANCED_CATEGORY = "routes.directions.advanced";
const PLACES_TEXT_SEARCH_PRO_CATEGORY = "places.text_search.pro";
const PLACES_DETAILS_ESSENTIALS_CATEGORY = "places.details.essentials";
const PLACES_DETAILS_PRO_CATEGORY = "places.details.pro";

const GOOGLE_GEOCODING_URL =
  "https://maps.googleapis.com/maps/api/geocode/json";
const GOOGLE_DIRECTIONS_URL =
  "https://maps.googleapis.com/maps/api/directions/json";
const GOOGLE_PLACES_SEARCH_TEXT_URL =
  "https://places.googleapis.com/v1/places:searchText";
const GOOGLE_PLACES_DETAILS_BASE_URL = "https://places.googleapis.com/v1/";

const PLACE_SEARCH_FIELD_MASK =
  "places.id,places.name,places.displayName,places.formattedAddress,places.location,places.types";
const PLACE_DETAILS_ESSENTIALS_FIELD_MASK =
  "id,name,formattedAddress,location,types,viewport,plusCode";
const PLACE_DETAILS_PRO_FIELD_MASK =
  "id,name,displayName,formattedAddress,location,types,viewport,plusCode,googleMapsUri,businessStatus";
const DEFAULT_LOCATION_BIAS_RADIUS_METERS = 50_000;

interface CreditCheckRow extends Record<string, unknown> {
  readonly credit_enabled: boolean | null;
  readonly credits: string | null;
  readonly unsettled_expired: string | null;
  readonly unit_price: string | null;
  readonly unit_size: string | null;
}

type ErrorStatus = 400 | 402 | 502 | 503;

interface MapsErrorResponse {
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

function insufficientCredits(): MapsErrorResponse {
  return {
    status: 402,
    body: errorBody(
      "Insufficient credits. Please add credits to continue.",
      "INSUFFICIENT_CREDITS",
    ),
  };
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

function placeDetailsFieldMask(fields: "essentials" | "pro"): string {
  return fields === "pro"
    ? PLACE_DETAILS_PRO_FIELD_MASK
    : PLACE_DETAILS_ESSENTIALS_FIELD_MASK;
}

function placeDetailsBillingCategory(fields: "essentials" | "pro"): string {
  return fields === "pro"
    ? PLACES_DETAILS_PRO_CATEGORY
    : PLACES_DETAILS_ESSENTIALS_CATEGORY;
}

function runIdForUsage(auth: AuthContext): string | undefined {
  return auth.tokenType === "zero" || auth.tokenType === "sandbox"
    ? auth.runId
    : undefined;
}

function estimatedCredits(unitPrice: string, unitSize: string): number {
  return Math.ceil(Number(unitPrice) / Number(unitSize));
}

const checkMapsCredits$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly category: string;
    },
    signal: AbortSignal,
  ): Promise<MapsErrorResponse | null> => {
    const writeDb = set(writeDb$);
    const { rows } = await writeDb.execute<CreditCheckRow>(sql`
      WITH pricing AS (
        SELECT unit_price, unit_size FROM usage_pricing
        WHERE kind = ${USAGE_KIND}
          AND provider = ${PROVIDER}
          AND category = ${args.category}
        LIMIT 1
      ),
      member AS (
        SELECT credit_enabled FROM org_members_metadata
        WHERE org_id = ${args.orgId} AND user_id = ${args.userId}
        LIMIT 1
      ),
      org AS (
        SELECT credits FROM org_metadata
        WHERE org_id = ${args.orgId}
        LIMIT 1
      ),
      expired AS (
        SELECT COALESCE(SUM(remaining), 0)::bigint AS total
        FROM credit_expires_record
        WHERE org_id = ${args.orgId}
          AND expires_at <= now()
          AND remaining > 0
      )
      SELECT
        (SELECT credit_enabled FROM member) AS credit_enabled,
        (SELECT credits FROM org) AS credits,
        (SELECT total FROM expired) AS unsettled_expired,
        (SELECT unit_price FROM pricing) AS unit_price,
        (SELECT unit_size FROM pricing) AS unit_size
    `);
    signal.throwIfAborted();

    const row = rows[0];
    if (row?.unit_price === null || row?.unit_size === null) {
      return serviceUnavailable(
        "Zero Maps pricing is not configured",
        "PRICING_NOT_CONFIGURED",
      );
    }

    if (!row || row.credit_enabled === false || row.credits === null) {
      return insufficientCredits();
    }

    const credits = Number(row.credits);
    const unsettledExpired = Number(row.unsettled_expired ?? 0);
    return credits - unsettledExpired >=
      estimatedCredits(row.unit_price, row.unit_size)
      ? null
      : insufficientCredits();
  },
);

const recordMapsUsage$ = command(
  async (
    { set },
    args: MapsUsageArgs,
    signal: AbortSignal,
  ): Promise<number> => {
    const writeDb = set(writeDb$);
    const [run] = args.runId
      ? await writeDb
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.id, args.runId),
              eq(agentRuns.orgId, args.orgId),
              eq(agentRuns.userId, args.userId),
            ),
          )
      : [];
    signal.throwIfAborted();

    const [inserted] = await writeDb
      .insert(usageEvent)
      .values({
        runId: run?.id ?? null,
        idempotencyKey: randomUUID(),
        orgId: args.orgId,
        userId: args.userId,
        kind: USAGE_KIND,
        provider: PROVIDER,
        category: args.category,
        quantity: 1,
      })
      .returning({ id: usageEvent.id });
    signal.throwIfAborted();

    if (!inserted) {
      throw new Error("Failed to insert maps usage event");
    }

    await set(processOrgUsageEvents$, args.orgId, signal);
    signal.throwIfAborted();

    const [processed] = await writeDb
      .select({ creditsCharged: usageEvent.creditsCharged })
      .from(usageEvent)
      .where(eq(usageEvent.id, inserted.id));
    signal.throwIfAborted();
    return processed?.creditsCharged ?? 0;
  },
);

export const zeroMapsGeocode$ = command(
  async (
    { set },
    args: AuthedMapsArgs<ZeroMapsGeocodeRequest>,
    signal: AbortSignal,
  ) => {
    const apiKey = env("ZERO_MAPS_GOOGLE_MAPS_TOKEN");
    if (!apiKey) {
      return serviceUnavailable(
        "Zero Maps Google Maps provider is not configured",
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
    signal.throwIfAborted();
    if (isMapsErrorResponse(result)) {
      return result;
    }
    const failure = legacyMapsFailure(result);
    if (failure) {
      return failure;
    }

    const creditsCharged = await set(
      recordMapsUsage$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: runIdForUsage(args.auth),
        category: GEOCODING_CATEGORY,
      },
      signal,
    );
    const body: ZeroMapsResponse = {
      operation: "geocode",
      provider: PROVIDER,
      creditsCharged,
      billingCategory: GEOCODING_CATEGORY,
      billingQuantity: 1,
      result,
    };
    return { status: 200 as const, body };
  },
);

export const zeroMapsReverseGeocode$ = command(
  async (
    { set },
    args: AuthedMapsArgs<ZeroMapsReverseGeocodeRequest>,
    signal: AbortSignal,
  ) => {
    const apiKey = env("ZERO_MAPS_GOOGLE_MAPS_TOKEN");
    if (!apiKey) {
      return serviceUnavailable(
        "Zero Maps Google Maps provider is not configured",
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
    signal.throwIfAborted();
    if (isMapsErrorResponse(result)) {
      return result;
    }
    const failure = legacyMapsFailure(result);
    if (failure) {
      return failure;
    }

    const creditsCharged = await set(
      recordMapsUsage$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: runIdForUsage(args.auth),
        category: GEOCODING_CATEGORY,
      },
      signal,
    );
    const body: ZeroMapsResponse = {
      operation: "reverse-geocode",
      provider: PROVIDER,
      creditsCharged,
      billingCategory: GEOCODING_CATEGORY,
      billingQuantity: 1,
      result,
    };
    return { status: 200 as const, body };
  },
);

export const zeroMapsDirections$ = command(
  async (
    { set },
    args: AuthedMapsArgs<ZeroMapsDirectionsRequest>,
    signal: AbortSignal,
  ) => {
    const apiKey = env("ZERO_MAPS_GOOGLE_MAPS_TOKEN");
    if (!apiKey) {
      return serviceUnavailable(
        "Zero Maps Google Maps provider is not configured",
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
    signal.throwIfAborted();
    if (isMapsErrorResponse(result)) {
      return result;
    }
    const failure = legacyMapsFailure(result);
    if (failure) {
      return failure;
    }

    const creditsCharged = await set(
      recordMapsUsage$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: runIdForUsage(args.auth),
        category: billingCategory,
      },
      signal,
    );
    const body: ZeroMapsResponse = {
      operation: "directions",
      provider: PROVIDER,
      creditsCharged,
      billingCategory,
      billingQuantity: 1,
      result,
    };
    return { status: 200 as const, body };
  },
);

export const zeroMapsPlacesSearch$ = command(
  async (
    { set },
    args: AuthedMapsArgs<ZeroMapsPlacesSearchRequest>,
    signal: AbortSignal,
  ) => {
    const apiKey = env("ZERO_MAPS_GOOGLE_MAPS_TOKEN");
    if (!apiKey) {
      return serviceUnavailable(
        "Zero Maps Google Maps provider is not configured",
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

    const creditError = await set(
      checkMapsCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        category: PLACES_TEXT_SEARCH_PRO_CATEGORY,
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
          "X-Goog-FieldMask": PLACE_SEARCH_FIELD_MASK,
        },
        body: JSON.stringify(requestBody),
        signal,
      },
    );
    signal.throwIfAborted();
    if (isMapsErrorResponse(result)) {
      return result;
    }

    const creditsCharged = await set(
      recordMapsUsage$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: runIdForUsage(args.auth),
        category: PLACES_TEXT_SEARCH_PRO_CATEGORY,
      },
      signal,
    );
    const body: ZeroMapsResponse = {
      operation: "places.search",
      provider: PROVIDER,
      creditsCharged,
      billingCategory: PLACES_TEXT_SEARCH_PRO_CATEGORY,
      billingQuantity: 1,
      result,
    };
    return { status: 200 as const, body };
  },
);

export const zeroMapsPlacesDetails$ = command(
  async (
    { set },
    args: AuthedMapsArgs<ZeroMapsPlacesDetailsRequest>,
    signal: AbortSignal,
  ) => {
    const apiKey = env("ZERO_MAPS_GOOGLE_MAPS_TOKEN");
    if (!apiKey) {
      return serviceUnavailable(
        "Zero Maps Google Maps provider is not configured",
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
    signal.throwIfAborted();
    if (isMapsErrorResponse(result)) {
      return result;
    }

    const creditsCharged = await set(
      recordMapsUsage$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: runIdForUsage(args.auth),
        category: billingCategory,
      },
      signal,
    );
    const body: ZeroMapsResponse = {
      operation: "places.details",
      provider: PROVIDER,
      creditsCharged,
      billingCategory,
      billingQuantity: 1,
      result,
    };
    return { status: 200 as const, body };
  },
);
