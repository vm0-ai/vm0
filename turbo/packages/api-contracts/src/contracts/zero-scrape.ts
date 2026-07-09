import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const zeroScrapeFormatSchema = z.enum(["markdown", "links"]);
export const zeroScrapeModeSchema = z.enum(["standard", "enhanced"]);
export const zeroScrapeBillingCategorySchema = z.enum([
  "standard.markdown",
  "standard.links",
  "enhanced.markdown",
  "enhanced.links",
]);

export const zeroScrapeRequestSchema = z.object({
  url: z.string().trim().url().max(2_048),
  format: zeroScrapeFormatSchema.default("markdown"),
  mode: zeroScrapeModeSchema.default("standard"),
});

export const zeroScrapeMetadataSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  language: z.string().optional(),
  statusCode: z.number().int().optional(),
  publishedTime: z.string().optional(),
});

const zeroScrapeResponseBaseSchema = z.object({
  requestedUrl: z.string(),
  finalUrl: z.string().optional(),
  provider: z.literal("firecrawl"),
  creditsCharged: z.number().int().nonnegative(),
  billingQuantity: z.number().int().positive(),
  metadata: zeroScrapeMetadataSchema.optional(),
});

const zeroScrapeMarkdownResultSchema = z.object({
  markdown: z.string(),
});

const zeroScrapeLinksResultSchema = z.object({
  links: z.array(z.string()),
});

const zeroScrapeStandardMarkdownResponseSchema =
  zeroScrapeResponseBaseSchema.extend({
    format: z.literal("markdown"),
    mode: z.literal("standard"),
    billingCategory: z.literal("standard.markdown"),
    result: zeroScrapeMarkdownResultSchema,
  });

const zeroScrapeEnhancedMarkdownResponseSchema =
  zeroScrapeResponseBaseSchema.extend({
    format: z.literal("markdown"),
    mode: z.literal("enhanced"),
    billingCategory: z.literal("enhanced.markdown"),
    result: zeroScrapeMarkdownResultSchema,
  });

const zeroScrapeStandardLinksResponseSchema =
  zeroScrapeResponseBaseSchema.extend({
    format: z.literal("links"),
    mode: z.literal("standard"),
    billingCategory: z.literal("standard.links"),
    result: zeroScrapeLinksResultSchema,
  });

const zeroScrapeEnhancedLinksResponseSchema =
  zeroScrapeResponseBaseSchema.extend({
    format: z.literal("links"),
    mode: z.literal("enhanced"),
    billingCategory: z.literal("enhanced.links"),
    result: zeroScrapeLinksResultSchema,
  });

export const zeroScrapeMarkdownResponseSchema = z.union([
  zeroScrapeStandardMarkdownResponseSchema,
  zeroScrapeEnhancedMarkdownResponseSchema,
]);

export const zeroScrapeLinksResponseSchema = z.union([
  zeroScrapeStandardLinksResponseSchema,
  zeroScrapeEnhancedLinksResponseSchema,
]);

export const zeroScrapeResponseSchema = z.union([
  zeroScrapeMarkdownResponseSchema,
  zeroScrapeLinksResponseSchema,
]);

export type ZeroScrapeRequest = z.infer<typeof zeroScrapeRequestSchema>;
export type ZeroScrapeResponse = z.infer<typeof zeroScrapeResponseSchema>;
export type ZeroScrapeFormat = z.infer<typeof zeroScrapeFormatSchema>;
export type ZeroScrapeMode = z.infer<typeof zeroScrapeModeSchema>;
export type ZeroScrapeBillingCategory = z.infer<
  typeof zeroScrapeBillingCategorySchema
>;

const scrapeResponses = {
  200: zeroScrapeResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const zeroScrapeContract = c.router({
  scrape: {
    method: "POST",
    path: "/api/zero/scrape",
    headers: authHeadersSchema,
    body: zeroScrapeRequestSchema,
    responses: scrapeResponses,
    summary: "Scrape a public web page through managed Zero Scrape",
  },
});

export type ZeroScrapeContract = typeof zeroScrapeContract;
