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

export const mapsOperationSchema = z.enum([
  "geocode",
  "reverse-geocode",
  "directions",
  "places.search",
  "places.details",
  "osm.download",
  "osm.render",
]);

export const mapsResponseSchema = z.object({
  operation: mapsOperationSchema,
  provider: z.enum(["google-maps", "openstreetmap"]),
  creditsCharged: z.number(),
  billingCategory: z.string(),
  billingQuantity: z.number(),
  result: z.unknown(),
});

export const mapsGeocodeRequestSchema = z.object({
  address: z.string().trim().min(1),
  region: z.string().trim().min(1).optional(),
});

export const mapsReverseGeocodeRequestSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const mapsDirectionsRequestSchema = z.object({
  origin: z.string().trim().min(1),
  destination: z.string().trim().min(1),
  mode: travelModeSchema.default("driving"),
  departureTime: z.string().trim().min(1).optional(),
});

export const mapsPlacesSearchRequestSchema = z.object({
  query: z.string().trim().min(1),
  location: z.string().trim().min(1).optional(),
  radius: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(20).default(5),
  region: z.string().trim().min(1).optional(),
  fields: placeSearchFieldsetSchema.default("pro"),
});

export const mapsPlacesDetailsRequestSchema = z.object({
  placeId: z.string().trim().min(1),
  fields: placeDetailFieldsetSchema.default("essentials"),
});

export const mapsOsmDownloadRequestSchema = validateOsmArea(
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

export const mapsOsmRenderRequestSchema = validateOsmArea(
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

export type MapsResponse = z.infer<typeof mapsResponseSchema>;
export type MapsGeocodeRequest = z.infer<typeof mapsGeocodeRequestSchema>;
export type MapsReverseGeocodeRequest = z.infer<
  typeof mapsReverseGeocodeRequestSchema
>;
export type MapsDirectionsRequest = z.infer<typeof mapsDirectionsRequestSchema>;
export type MapsPlacesSearchRequest = z.infer<
  typeof mapsPlacesSearchRequestSchema
>;
export type MapsPlacesDetailsRequest = z.infer<
  typeof mapsPlacesDetailsRequestSchema
>;
export type MapsOsmDownloadRequest = z.infer<
  typeof mapsOsmDownloadRequestSchema
>;
export type MapsOsmRenderRequest = z.infer<typeof mapsOsmRenderRequestSchema>;

const mapsResponses = {
  200: mapsResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const mapsContract = c.router({
  geocode: {
    method: "POST",
    path: "/api/maps/geocode",
    headers: authHeadersSchema,
    body: mapsGeocodeRequestSchema,
    responses: mapsResponses,
    summary: "Geocode an address through managed Okou Maps",
  },
  reverseGeocode: {
    method: "POST",
    path: "/api/maps/reverse-geocode",
    headers: authHeadersSchema,
    body: mapsReverseGeocodeRequestSchema,
    responses: mapsResponses,
    summary: "Reverse geocode coordinates through managed Okou Maps",
  },
  directions: {
    method: "POST",
    path: "/api/maps/directions",
    headers: authHeadersSchema,
    body: mapsDirectionsRequestSchema,
    responses: mapsResponses,
    summary: "Compute directions through managed Okou Maps",
  },
  placesSearch: {
    method: "POST",
    path: "/api/maps/places/search",
    headers: authHeadersSchema,
    body: mapsPlacesSearchRequestSchema,
    responses: mapsResponses,
    summary: "Search places through managed Okou Maps",
  },
  placesDetails: {
    method: "POST",
    path: "/api/maps/places/details",
    headers: authHeadersSchema,
    body: mapsPlacesDetailsRequestSchema,
    responses: mapsResponses,
    summary: "Fetch place details through managed Okou Maps",
  },
  osmDownload: {
    method: "POST",
    path: "/api/maps/osm/download",
    headers: authHeadersSchema,
    body: mapsOsmDownloadRequestSchema,
    responses: mapsResponses,
    summary: "Download OpenStreetMap features through managed Okou Maps",
  },
  osmRender: {
    method: "POST",
    path: "/api/maps/osm/render",
    headers: authHeadersSchema,
    body: mapsOsmRenderRequestSchema,
    responses: mapsResponses,
    summary: "Render OpenStreetMap features to PNG through managed Okou Maps",
  },
});

export type MapsContract = typeof mapsContract;
