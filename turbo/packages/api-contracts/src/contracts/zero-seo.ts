import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const ZERO_SEO_DEFAULT_LOCATION = "United States" as const;
export const ZERO_SEO_DEFAULT_LANGUAGE_CODE = "en" as const;
export const ZERO_SEO_DEFAULT_COUNTRY_CODE = "us" as const;
export const ZERO_SEO_DEFAULT_SERP_LIMIT = 10;
export const ZERO_SEO_DEFAULT_ANALYSIS_LIMIT = 100;
export const ZERO_SEO_MAX_SERP_LIMIT = 100;
export const ZERO_SEO_MAX_ANALYSIS_LIMIT = 100;
export const ZERO_SEO_MAX_QUERY_CHARS = 512;
export const ZERO_SEO_MAX_KEYWORD_CHARS = 512;
export const ZERO_SEO_MAX_TARGET_CHARS = 2048;
export const ZERO_SEO_MAX_LOCATION_CHARS = 256;

export const zeroSeoProviderSchema = z.enum(["dataforseo", "serpapi"]);

export const zeroSeoEngineSchema = z.enum([
  "google",
  "bing",
  "google_maps",
  "google_news",
  "google_shopping",
]);

export const zeroSeoDeviceSchema = z.enum(["desktop", "mobile"]);

export const zeroSeoLanguageCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(10)
  .regex(/^[a-z]{2,3}(?:-[a-z]{2,4})?$/i, "language must be a language code");

export const zeroSeoCountryCodeSchema = z
  .string()
  .trim()
  .length(2)
  .regex(/^[a-z]{2}$/i, "country must be a two-letter country code");

const zeroSeoLocationSchema = z
  .string()
  .trim()
  .min(1)
  .max(ZERO_SEO_MAX_LOCATION_CHARS);

const zeroSeoDomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((value) => {
    return (
      !value.includes("://") &&
      !value.includes("/") &&
      !value.includes("?") &&
      !value.includes("#") &&
      value.includes(".")
    );
  }, "target must be a domain without a protocol or path");

export const zeroSeoSerpRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(ZERO_SEO_MAX_QUERY_CHARS),
    provider: zeroSeoProviderSchema.default("dataforseo"),
    engine: zeroSeoEngineSchema.default("google"),
    location: zeroSeoLocationSchema.default(ZERO_SEO_DEFAULT_LOCATION),
    languageCode: zeroSeoLanguageCodeSchema.default(
      ZERO_SEO_DEFAULT_LANGUAGE_CODE,
    ),
    countryCode: zeroSeoCountryCodeSchema.default(
      ZERO_SEO_DEFAULT_COUNTRY_CODE,
    ),
    device: zeroSeoDeviceSchema.default("desktop"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(ZERO_SEO_MAX_SERP_LIMIT)
      .default(ZERO_SEO_DEFAULT_SERP_LIMIT),
  })
  .superRefine((value, context) => {
    if (value.provider === "dataforseo" && value.engine === "google_shopping") {
      context.addIssue({
        code: "custom",
        path: ["engine"],
        message:
          "DataForSEO Google Shopping is asynchronous; use SerpAPI for the google_shopping engine",
      });
    }
    if (
      value.provider === "dataforseo" &&
      value.engine === "google_news" &&
      value.device === "mobile"
    ) {
      context.addIssue({
        code: "custom",
        path: ["device"],
        message: "DataForSEO Google News supports only the desktop device",
      });
    }
  });

export const zeroSeoKeywordIdeasRequestSchema = z.object({
  keyword: z.string().trim().min(3).max(ZERO_SEO_MAX_KEYWORD_CHARS),
  location: zeroSeoLocationSchema.default(ZERO_SEO_DEFAULT_LOCATION),
  languageCode: zeroSeoLanguageCodeSchema.default(
    ZERO_SEO_DEFAULT_LANGUAGE_CODE,
  ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(ZERO_SEO_MAX_ANALYSIS_LIMIT)
    .default(ZERO_SEO_DEFAULT_ANALYSIS_LIMIT),
});

export const zeroSeoRankedKeywordsRequestSchema = z.object({
  target: zeroSeoDomainSchema,
  location: zeroSeoLocationSchema.default(ZERO_SEO_DEFAULT_LOCATION),
  languageCode: zeroSeoLanguageCodeSchema.default(
    ZERO_SEO_DEFAULT_LANGUAGE_CODE,
  ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(ZERO_SEO_MAX_ANALYSIS_LIMIT)
    .default(ZERO_SEO_DEFAULT_ANALYSIS_LIMIT),
});

export const zeroSeoBacklinksSummaryRequestSchema = z.object({
  target: z.string().trim().min(1).max(ZERO_SEO_MAX_TARGET_CHARS),
  includeSubdomains: z.boolean().default(true),
});

export const zeroSeoOperationSchema = z.enum([
  "serp",
  "keyword-ideas",
  "ranked-keywords",
  "backlinks-summary",
]);

const zeroSeoResponseBaseSchema = z.object({
  operation: zeroSeoOperationSchema,
  creditsCharged: z.number().int().nonnegative(),
  result: z.unknown(),
});

const zeroSeoDataForSeoResponseSchema = zeroSeoResponseBaseSchema.extend({
  provider: z.literal("dataforseo"),
  billingCategory: z.literal("provider_cost_usd_micros"),
  billingQuantity: z.number().int().nonnegative(),
  providerCostUsd: z.number().nonnegative(),
});

const zeroSeoSerpApiResponseSchema = zeroSeoResponseBaseSchema.extend({
  provider: z.literal("serpapi"),
  billingCategory: z.literal("search"),
  billingQuantity: z.union([z.literal(0), z.literal(1)]),
  cached: z.boolean(),
});

export const zeroSeoResponseSchema = z.discriminatedUnion("provider", [
  zeroSeoDataForSeoResponseSchema,
  zeroSeoSerpApiResponseSchema,
]);

export type ZeroSeoProvider = z.infer<typeof zeroSeoProviderSchema>;
export type ZeroSeoEngine = z.infer<typeof zeroSeoEngineSchema>;
export type ZeroSeoDevice = z.infer<typeof zeroSeoDeviceSchema>;
export type ZeroSeoSerpRequest = z.infer<typeof zeroSeoSerpRequestSchema>;
export type ZeroSeoKeywordIdeasRequest = z.infer<
  typeof zeroSeoKeywordIdeasRequestSchema
>;
export type ZeroSeoRankedKeywordsRequest = z.infer<
  typeof zeroSeoRankedKeywordsRequestSchema
>;
export type ZeroSeoBacklinksSummaryRequest = z.infer<
  typeof zeroSeoBacklinksSummaryRequestSchema
>;
export type ZeroSeoOperation = z.infer<typeof zeroSeoOperationSchema>;
export type ZeroSeoResponse = z.infer<typeof zeroSeoResponseSchema>;

const seoResponses = {
  200: zeroSeoResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const zeroSeoContract = c.router({
  serp: {
    method: "POST",
    path: "/api/zero/seo/serp",
    headers: authHeadersSchema,
    body: zeroSeoSerpRequestSchema,
    responses: seoResponses,
    summary: "Fetch live search engine results through managed Zero SEO",
  },
  keywordIdeas: {
    method: "POST",
    path: "/api/zero/seo/keyword-ideas",
    headers: authHeadersSchema,
    body: zeroSeoKeywordIdeasRequestSchema,
    responses: seoResponses,
    summary: "Find related keyword ideas through managed Zero SEO",
  },
  rankedKeywords: {
    method: "POST",
    path: "/api/zero/seo/ranked-keywords",
    headers: authHeadersSchema,
    body: zeroSeoRankedKeywordsRequestSchema,
    responses: seoResponses,
    summary: "List ranked keywords for a domain through managed Zero SEO",
  },
  backlinksSummary: {
    method: "POST",
    path: "/api/zero/seo/backlinks-summary",
    headers: authHeadersSchema,
    body: zeroSeoBacklinksSummaryRequestSchema,
    responses: seoResponses,
    summary: "Fetch a backlink summary through managed Zero SEO",
  },
});

export type ZeroSeoContract = typeof zeroSeoContract;
