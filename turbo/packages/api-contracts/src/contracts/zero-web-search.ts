import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const ZERO_WEB_SEARCH_DEFAULT_LIMIT = 5;
export const ZERO_WEB_SEARCH_MAX_LIMIT = 10;
export const ZERO_WEB_SEARCH_MAX_QUERY_CHARS = 2_048;
export const ZERO_WEB_SEARCH_MAX_DOMAINS = 20;
export const ZERO_WEB_SEARCH_MAX_DOMAIN_CHARS = 253;
export const ZERO_WEB_SEARCH_MAX_TITLE_CHARS = 512;
export const ZERO_WEB_SEARCH_MAX_URL_CHARS = 2_048;
export const ZERO_WEB_SEARCH_MAX_SNIPPET_CHARS = 8_000;
export const ZERO_WEB_SEARCH_MAX_DATE_CHARS = 64;

const domainLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function isDomain(value: string): boolean {
  const labels = value.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => {
      return domainLabelPattern.test(label);
    })
  );
}

export const zeroWebSearchRecencySchema = z.enum([
  "hour",
  "day",
  "week",
  "month",
  "year",
]);

export const zeroWebSearchDomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(ZERO_WEB_SEARCH_MAX_DOMAIN_CHARS)
  .refine(isDomain, {
    message: "Domain must be a domain or subdomain without a protocol or path",
  })
  .transform((domain) => {
    return domain.toLowerCase();
  });

const zeroWebSearchDomainsSchema = z
  .array(zeroWebSearchDomainSchema)
  .max(ZERO_WEB_SEARCH_MAX_DOMAINS)
  .transform((domains) => {
    return [...new Set(domains)];
  });

export const zeroWebSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(ZERO_WEB_SEARCH_MAX_QUERY_CHARS),
  limit: z
    .number()
    .int()
    .min(1)
    .max(ZERO_WEB_SEARCH_MAX_LIMIT)
    .default(ZERO_WEB_SEARCH_DEFAULT_LIMIT),
  recency: zeroWebSearchRecencySchema.optional(),
  domains: zeroWebSearchDomainsSchema.optional(),
});

const zeroWebSearchHttpUrlSchema = z
  .string()
  .max(ZERO_WEB_SEARCH_MAX_URL_CHARS)
  .url()
  .regex(/^https?:\/\//i, "Result URL must use http or https");

export const zeroWebSearchResultSchema = z.object({
  rank: z.number().int().min(1).max(ZERO_WEB_SEARCH_MAX_LIMIT),
  title: z.string().max(ZERO_WEB_SEARCH_MAX_TITLE_CHARS),
  url: zeroWebSearchHttpUrlSchema,
  snippet: z.string().max(ZERO_WEB_SEARCH_MAX_SNIPPET_CHARS),
  publishedDate: z.string().max(ZERO_WEB_SEARCH_MAX_DATE_CHARS).optional(),
  lastUpdatedDate: z.string().max(ZERO_WEB_SEARCH_MAX_DATE_CHARS).optional(),
});

export const zeroWebSearchResponseSchema = z.object({
  query: z.string().max(ZERO_WEB_SEARCH_MAX_QUERY_CHARS),
  limit: z.number().int().min(1).max(ZERO_WEB_SEARCH_MAX_LIMIT),
  recency: zeroWebSearchRecencySchema.optional(),
  domains: z
    .array(zeroWebSearchDomainSchema)
    .max(ZERO_WEB_SEARCH_MAX_DOMAINS)
    .optional(),
  provider: z.literal("perplexity"),
  billingCategory: z.literal("request"),
  billingQuantity: z.literal(1),
  creditsCharged: z.number().int().nonnegative(),
  results: z.array(zeroWebSearchResultSchema).max(ZERO_WEB_SEARCH_MAX_LIMIT),
});

export type ZeroWebSearchRecency = z.infer<typeof zeroWebSearchRecencySchema>;
export type ZeroWebSearchRequest = z.infer<typeof zeroWebSearchRequestSchema>;
export type ZeroWebSearchResult = z.infer<typeof zeroWebSearchResultSchema>;
export type ZeroWebSearchResponse = z.infer<typeof zeroWebSearchResponseSchema>;

const webSearchResponses = {
  200: zeroWebSearchResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const zeroWebSearchContract = c.router({
  search: {
    method: "POST",
    path: "/api/okou/web-search",
    headers: authHeadersSchema,
    body: zeroWebSearchRequestSchema,
    responses: webSearchResponses,
    summary: "Search the public web through managed Zero Web Search",
  },
});

export type ZeroWebSearchContract = typeof zeroWebSearchContract;
