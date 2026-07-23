import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const ZERO_WEATHER_ATTRIBUTION =
  "Source: Includes weather data from Google";

export const zeroWeatherOperationSchema = z.enum([
  "current",
  "forecast.hourly",
  "forecast.daily",
  "history.hourly",
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

export const zeroWeatherResponseSchema = z.object({
  operation: zeroWeatherOperationSchema,
  provider: z.literal("google-weather"),
  attribution: z.literal(ZERO_WEATHER_ATTRIBUTION),
  creditsCharged: z.number(),
  billingCategory: z.string(),
  billingQuantity: z.number(),
  result: z.unknown(),
});

export type ZeroWeatherResponse = z.infer<typeof zeroWeatherResponseSchema>;
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

const weatherResponses = {
  200: zeroWeatherResponseSchema,
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
});

export type ZeroWeatherContract = typeof zeroWeatherContract;
