import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const travelModeSchema = z.enum(["driving", "walking", "bicycling", "transit"]);
const placeSearchFieldsetSchema = z.enum(["pro", "enterprise"]);
const placeDetailFieldsetSchema = z.enum(["essentials", "pro", "enterprise"]);
const osmLayerSchema = z.enum(["roads", "buildings", "water", "parks"]);
const osmStyleSchema = z.enum(["standard", "guide"]);
const osmBBoxSchema = z.object({
  west: z.number().min(-180).max(180),
  south: z.number().min(-90).max(90),
  east: z.number().min(-180).max(180),
  north: z.number().min(-90).max(90),
});
const osmCenterSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
const osmMarkerSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  label: z.string().trim().min(1).max(80).optional(),
});
const osmAreaRequestBaseSchema = z.object({
  bbox: osmBBoxSchema.optional(),
  center: osmCenterSchema.optional(),
  radiusMeters: z.number().int().min(50).max(5_000).optional(),
});
const defaultOsmLayers = ["roads", "buildings", "water", "parks"] as const;

function validateOsmArea<T extends z.infer<typeof osmAreaRequestBaseSchema>>(
  schema: z.ZodType<T>,
) {
  return schema
    .refine((value) => {
      return value.bbox !== undefined
        ? value.center === undefined && value.radiusMeters === undefined
        : value.center !== undefined && value.radiusMeters !== undefined;
    }, "Provide either bbox or center with radiusMeters")
    .refine((value) => {
      if (!value.bbox) {
        return true;
      }
      return (
        value.bbox.east > value.bbox.west && value.bbox.north > value.bbox.south
      );
    }, "bbox east/north must be greater than west/south");
}

export const zeroMapsOperationSchema = z.enum([
  "geocode",
  "reverse-geocode",
  "directions",
  "places.search",
  "places.details",
  "osm.download",
  "osm.render",
]);

export const zeroMapsResponseSchema = z.object({
  operation: zeroMapsOperationSchema,
  provider: z.enum(["google-maps", "openstreetmap"]),
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
  fields: placeSearchFieldsetSchema.default("pro"),
});

export const zeroMapsPlacesDetailsRequestSchema = z.object({
  placeId: z.string().trim().min(1),
  fields: placeDetailFieldsetSchema.default("essentials"),
});

export const zeroMapsOsmDownloadRequestSchema = validateOsmArea(
  osmAreaRequestBaseSchema.extend({
    layers: z
      .array(osmLayerSchema)
      .min(1)
      .max(4)
      .default(() => {
        return [...defaultOsmLayers];
      }),
  }),
);

export const zeroMapsOsmRenderRequestSchema = validateOsmArea(
  osmAreaRequestBaseSchema.extend({
    layers: z
      .array(osmLayerSchema)
      .min(1)
      .max(4)
      .default(() => {
        return [...defaultOsmLayers];
      }),
    width: z.number().int().min(320).max(2_048).default(1_536),
    height: z.number().int().min(240).max(2_048).default(1_024),
    style: osmStyleSchema.default("standard"),
    title: z.string().trim().min(1).max(120).optional(),
    markers: z.array(osmMarkerSchema).max(100).default([]),
  }),
);

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
export type ZeroMapsOsmDownloadRequest = z.infer<
  typeof zeroMapsOsmDownloadRequestSchema
>;
export type ZeroMapsOsmRenderRequest = z.infer<
  typeof zeroMapsOsmRenderRequestSchema
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
  osmDownload: {
    method: "POST",
    path: "/api/zero/maps/osm/download",
    headers: authHeadersSchema,
    body: zeroMapsOsmDownloadRequestSchema,
    responses: mapsResponses,
    summary: "Download OpenStreetMap features through managed Zero Maps",
  },
  osmRender: {
    method: "POST",
    path: "/api/zero/maps/osm/render",
    headers: authHeadersSchema,
    body: zeroMapsOsmRenderRequestSchema,
    responses: mapsResponses,
    summary: "Render OpenStreetMap features to PNG through managed Zero Maps",
  },
});

export type ZeroMapsContract = typeof zeroMapsContract;
