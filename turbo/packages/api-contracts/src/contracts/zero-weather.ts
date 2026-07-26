import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const ZERO_WEATHER_ATTRIBUTION =
  "Source: Includes weather data from Google";
export const ZERO_AIR_QUALITY_ATTRIBUTION =
  "Source: Includes air quality data from Google";

const zeroWeatherConditionsOperationSchema = z.enum([
  "current",
  "forecast.hourly",
  "forecast.daily",
  "history.hourly",
]);
export const zeroWeatherOperationSchema = z.enum([
  ...zeroWeatherConditionsOperationSchema.options,
  "air-quality.current",
]);

export const zeroWeatherUnitsSchema = z.enum(["metric", "imperial"]);

const zeroWeatherLocationRequestSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  units: zeroWeatherUnitsSchema.default("metric"),
  languageCode: z.string().trim().min(1).optional(),
});

const zeroWeatherHourlyPageRequestSchema =
  zeroWeatherLocationRequestSchema.extend({
    pageSize: z.number().int().min(1).max(24).optional(),
    pageToken: z.string().trim().min(1).optional(),
  });

export const zeroWeatherCurrentRequestSchema = zeroWeatherLocationRequestSchema;

export const zeroWeatherForecastHourlyRequestSchema =
  zeroWeatherHourlyPageRequestSchema.extend({
    hours: z.number().int().min(1).max(240).optional(),
  });

export const zeroWeatherForecastDailyRequestSchema =
  zeroWeatherLocationRequestSchema.extend({
    days: z.number().int().min(1).max(10).optional(),
    pageSize: z.number().int().min(1).max(10).optional(),
    pageToken: z.string().trim().min(1).optional(),
  });

export const zeroWeatherHistoryHourlyRequestSchema =
  zeroWeatherHourlyPageRequestSchema.extend({
    hours: z.number().int().min(1).max(24).optional(),
  });

export const zeroAirQualityCurrentRequestSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  languageCode: z.string().trim().min(1).optional(),
});

const zeroWeatherResponseBaseSchema = z.object({
  creditsCharged: z.number(),
  billingCategory: z.string(),
  billingQuantity: z.number(),
  result: z.unknown(),
});

export const zeroWeatherConditionsResponseSchema =
  zeroWeatherResponseBaseSchema.extend({
    operation: zeroWeatherConditionsOperationSchema,
    provider: z.literal("google-weather"),
    attribution: z.literal(ZERO_WEATHER_ATTRIBUTION),
  });

export const zeroAirQualityResponseSchema =
  zeroWeatherResponseBaseSchema.extend({
    operation: z.literal("air-quality.current"),
    provider: z.literal("google-air-quality"),
    attribution: z.literal(ZERO_AIR_QUALITY_ATTRIBUTION),
  });

export const zeroWeatherResponseSchema = z.discriminatedUnion("provider", [
  zeroWeatherConditionsResponseSchema,
  zeroAirQualityResponseSchema,
]);

export type ZeroWeatherResponse = z.infer<typeof zeroWeatherResponseSchema>;
export type ZeroWeatherConditionsResponse = z.infer<
  typeof zeroWeatherConditionsResponseSchema
>;
export type ZeroAirQualityResponse = z.infer<
  typeof zeroAirQualityResponseSchema
>;
export type ZeroWeatherCurrentRequest = z.infer<
  typeof zeroWeatherCurrentRequestSchema
>;
export type ZeroWeatherForecastHourlyRequest = z.infer<
  typeof zeroWeatherForecastHourlyRequestSchema
>;
export type ZeroWeatherForecastDailyRequest = z.infer<
  typeof zeroWeatherForecastDailyRequestSchema
>;
export type ZeroWeatherHistoryHourlyRequest = z.infer<
  typeof zeroWeatherHistoryHourlyRequestSchema
>;
export type ZeroAirQualityCurrentRequest = z.infer<
  typeof zeroAirQualityCurrentRequestSchema
>;

const weatherResponses = {
  200: zeroWeatherConditionsResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

const airQualityResponses = {
  200: zeroAirQualityResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const zeroWeatherContract = c.router({
  current: {
    method: "POST",
    path: "/api/zero/weather/current",
    headers: authHeadersSchema,
    body: zeroWeatherCurrentRequestSchema,
    responses: weatherResponses,
    summary: "Get current conditions through managed Zero Weather",
  },
  forecastHourly: {
    method: "POST",
    path: "/api/zero/weather/forecast/hourly",
    headers: authHeadersSchema,
    body: zeroWeatherForecastHourlyRequestSchema,
    responses: weatherResponses,
    summary: "Get an hourly forecast through managed Zero Weather",
  },
  forecastDaily: {
    method: "POST",
    path: "/api/zero/weather/forecast/daily",
    headers: authHeadersSchema,
    body: zeroWeatherForecastDailyRequestSchema,
    responses: weatherResponses,
    summary: "Get a daily forecast through managed Zero Weather",
  },
  historyHourly: {
    method: "POST",
    path: "/api/zero/weather/history/hourly",
    headers: authHeadersSchema,
    body: zeroWeatherHistoryHourlyRequestSchema,
    responses: weatherResponses,
    summary: "Get recent hourly history through managed Zero Weather",
  },
  airQualityCurrent: {
    method: "POST",
    path: "/api/zero/weather/air-quality/current",
    headers: authHeadersSchema,
    body: zeroAirQualityCurrentRequestSchema,
    responses: airQualityResponses,
    summary: "Get current air quality through managed Zero Weather",
  },
});

export type ZeroWeatherContract = typeof zeroWeatherContract;
