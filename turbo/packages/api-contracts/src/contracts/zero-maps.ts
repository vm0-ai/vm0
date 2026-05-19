import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const travelModeSchema = z.enum(["driving", "walking", "bicycling", "transit"]);
const placeDetailFieldsetSchema = z.enum(["essentials", "pro"]);

export const zeroMapsOperationSchema = z.enum([
  "geocode",
  "reverse-geocode",
  "directions",
  "places.search",
  "places.details",
]);

export const zeroMapsResponseSchema = z.object({
  operation: zeroMapsOperationSchema,
  provider: z.literal("google-maps"),
  creditsCharged: z.number(),
  billingCategory: z.string(),
  billingQuantity: z.number(),
  result: z.unknown(),
});

export const zeroMapsGeocodeRequestSchema = z.object({
  address: z.string().trim().min(1),
  region: z.string().trim().min(1).optional(),
});

export const zeroMapsReverseGeocodeRequestSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const zeroMapsDirectionsRequestSchema = z.object({
  origin: z.string().trim().min(1),
  destination: z.string().trim().min(1),
  mode: travelModeSchema.default("driving"),
  departureTime: z.string().trim().min(1).optional(),
});

export const zeroMapsPlacesSearchRequestSchema = z.object({
  query: z.string().trim().min(1),
  location: z.string().trim().min(1).optional(),
  radius: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(20).default(5),
  region: z.string().trim().min(1).optional(),
});

export const zeroMapsPlacesDetailsRequestSchema = z.object({
  placeId: z.string().trim().min(1),
  fields: placeDetailFieldsetSchema.default("essentials"),
});

export type ZeroMapsResponse = z.infer<typeof zeroMapsResponseSchema>;
export type ZeroMapsGeocodeRequest = z.infer<
  typeof zeroMapsGeocodeRequestSchema
>;
export type ZeroMapsReverseGeocodeRequest = z.infer<
  typeof zeroMapsReverseGeocodeRequestSchema
>;
export type ZeroMapsDirectionsRequest = z.infer<
  typeof zeroMapsDirectionsRequestSchema
>;
export type ZeroMapsPlacesSearchRequest = z.infer<
  typeof zeroMapsPlacesSearchRequestSchema
>;
export type ZeroMapsPlacesDetailsRequest = z.infer<
  typeof zeroMapsPlacesDetailsRequestSchema
>;

const mapsResponses = {
  200: zeroMapsResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const zeroMapsContract = c.router({
  geocode: {
    method: "POST",
    path: "/api/zero/maps/geocode",
    headers: authHeadersSchema,
    body: zeroMapsGeocodeRequestSchema,
    responses: mapsResponses,
    summary: "Geocode an address through managed Zero Maps",
  },
  reverseGeocode: {
    method: "POST",
    path: "/api/zero/maps/reverse-geocode",
    headers: authHeadersSchema,
    body: zeroMapsReverseGeocodeRequestSchema,
    responses: mapsResponses,
    summary: "Reverse geocode coordinates through managed Zero Maps",
  },
  directions: {
    method: "POST",
    path: "/api/zero/maps/directions",
    headers: authHeadersSchema,
    body: zeroMapsDirectionsRequestSchema,
    responses: mapsResponses,
    summary: "Compute directions through managed Zero Maps",
  },
  placesSearch: {
    method: "POST",
    path: "/api/zero/maps/places/search",
    headers: authHeadersSchema,
    body: zeroMapsPlacesSearchRequestSchema,
    responses: mapsResponses,
    summary: "Search places through managed Zero Maps",
  },
  placesDetails: {
    method: "POST",
    path: "/api/zero/maps/places/details",
    headers: authHeadersSchema,
    body: zeroMapsPlacesDetailsRequestSchema,
    responses: mapsResponses,
    summary: "Fetch place details through managed Zero Maps",
  },
});

export type ZeroMapsContract = typeof zeroMapsContract;
