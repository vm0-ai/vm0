import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const ZERO_PEOPLE_SEARCH_DEFAULT_LIMIT = 5;
export const ZERO_PEOPLE_SEARCH_MAX_LIMIT = 10;
export const ZERO_PEOPLE_SEARCH_MAX_QUERY_CHARS = 2_048;
export const ZERO_PEOPLE_SEARCH_MAX_NAME_CHARS = 256;
export const ZERO_PEOPLE_SEARCH_MAX_TITLE_CHARS = 512;
export const ZERO_PEOPLE_SEARCH_MAX_COMPANY_CHARS = 256;
export const ZERO_PEOPLE_SEARCH_MAX_LOCATION_CHARS = 256;
export const ZERO_PEOPLE_SEARCH_MAX_SUMMARY_CHARS = 1_000;
export const ZERO_PEOPLE_SEARCH_MAX_SOURCE_TITLE_CHARS = 512;
export const ZERO_PEOPLE_SEARCH_MAX_SOURCE_URL_CHARS = 2_048;
export const ZERO_PEOPLE_SEARCH_MAX_SOURCES = 5;

export const zeroPeopleSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(ZERO_PEOPLE_SEARCH_MAX_QUERY_CHARS),
  limit: z
    .number()
    .int()
    .min(1)
    .max(ZERO_PEOPLE_SEARCH_MAX_LIMIT)
    .default(ZERO_PEOPLE_SEARCH_DEFAULT_LIMIT),
});

const zeroPeopleSearchHttpUrlSchema = z
  .string()
  .max(ZERO_PEOPLE_SEARCH_MAX_SOURCE_URL_CHARS)
  .url()
  .regex(/^https?:\/\//i, "Source URL must use http or https");

export const zeroPeopleSearchSourceSchema = z.object({
  title: z.string().max(ZERO_PEOPLE_SEARCH_MAX_SOURCE_TITLE_CHARS),
  url: zeroPeopleSearchHttpUrlSchema,
});

export const zeroPeopleSearchProfileSchema = z.object({
  name: z.string().min(1).max(ZERO_PEOPLE_SEARCH_MAX_NAME_CHARS),
  title: z.string().max(ZERO_PEOPLE_SEARCH_MAX_TITLE_CHARS).optional(),
  company: z.string().max(ZERO_PEOPLE_SEARCH_MAX_COMPANY_CHARS).optional(),
  location: z.string().max(ZERO_PEOPLE_SEARCH_MAX_LOCATION_CHARS).optional(),
  summary: z.string().max(ZERO_PEOPLE_SEARCH_MAX_SUMMARY_CHARS).optional(),
  sources: z
    .array(zeroPeopleSearchSourceSchema)
    .min(1)
    .max(ZERO_PEOPLE_SEARCH_MAX_SOURCES),
});

export const zeroPeopleSearchResponseSchema = z.object({
  query: z.string().max(ZERO_PEOPLE_SEARCH_MAX_QUERY_CHARS),
  limit: z.number().int().min(1).max(ZERO_PEOPLE_SEARCH_MAX_LIMIT),
  provider: z.literal("perplexity"),
  billingCategory: z.literal("request"),
  billingQuantity: z.literal(1),
  creditsCharged: z.number().int().nonnegative(),
  profiles: z
    .array(zeroPeopleSearchProfileSchema)
    .max(ZERO_PEOPLE_SEARCH_MAX_LIMIT),
});

export type ZeroPeopleSearchRequest = z.infer<
  typeof zeroPeopleSearchRequestSchema
>;
export type ZeroPeopleSearchSource = z.infer<
  typeof zeroPeopleSearchSourceSchema
>;
export type ZeroPeopleSearchProfile = z.infer<
  typeof zeroPeopleSearchProfileSchema
>;
export type ZeroPeopleSearchResponse = z.infer<
  typeof zeroPeopleSearchResponseSchema
>;

export const zeroPeopleSearchContract = c.router({
  search: {
    method: "POST",
    path: "/api/zero/people-search",
    headers: authHeadersSchema,
    body: zeroPeopleSearchRequestSchema,
    responses: {
      200: zeroPeopleSearchResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Find professionals through managed Zero People Search",
  },
});

export type ZeroPeopleSearchContract = typeof zeroPeopleSearchContract;
