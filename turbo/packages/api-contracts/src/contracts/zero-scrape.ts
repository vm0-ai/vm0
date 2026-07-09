import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const zeroScrapeFormatSchema = z.enum(["markdown", "links"]);
export const zeroScrapeModeSchema = z.enum(["standard", "enhanced"]);

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

export const zeroScrapeResultSchema = z.object({
  markdown: z.string().optional(),
  links: z.array(z.string()).optional(),
});

export const zeroScrapeResponseSchema = z.object({
  requestedUrl: z.string(),
  finalUrl: z.string().optional(),
  format: zeroScrapeFormatSchema,
  mode: zeroScrapeModeSchema,
  provider: z.literal("firecrawl"),
  creditsCharged: z.number(),
  billingCategory: z.string(),
  billingQuantity: z.number(),
  result: zeroScrapeResultSchema,
  metadata: zeroScrapeMetadataSchema.optional(),
});

export type ZeroScrapeRequest = z.infer<typeof zeroScrapeRequestSchema>;
export type ZeroScrapeResponse = z.infer<typeof zeroScrapeResponseSchema>;
export type ZeroScrapeFormat = z.infer<typeof zeroScrapeFormatSchema>;
export type ZeroScrapeMode = z.infer<typeof zeroScrapeModeSchema>;

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
