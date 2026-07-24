import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const ZERO_FINANCE_DEFAULT_RANGE = "1y" as const;
export const ZERO_FINANCE_DEFAULT_INTERVAL = "1d" as const;
export const ZERO_FINANCE_MAX_QUERY_CHARS = 512;
export const ZERO_FINANCE_MAX_SYMBOL_CHARS = 64;

export const zeroFinanceRangeSchema = z.enum([
  "1d",
  "5d",
  "1mo",
  "3mo",
  "6mo",
  "1y",
  "2y",
  "5y",
  "10y",
  "ytd",
  "max",
]);

export const zeroFinanceIntervalSchema = z.enum([
  "1m",
  "2m",
  "5m",
  "15m",
  "30m",
  "60m",
  "1d",
  "1wk",
  "1mo",
]);

export const zeroFinanceSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(ZERO_FINANCE_MAX_QUERY_CHARS),
});

const zeroFinanceSymbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(ZERO_FINANCE_MAX_SYMBOL_CHARS);

export const zeroFinanceProfileRequestSchema = z.object({
  symbol: zeroFinanceSymbolSchema,
});

export const zeroFinanceQuoteRequestSchema = z.object({
  symbol: zeroFinanceSymbolSchema,
});

export const zeroFinanceChartRequestSchema = z.object({
  symbol: zeroFinanceSymbolSchema,
  range: zeroFinanceRangeSchema.default(ZERO_FINANCE_DEFAULT_RANGE),
  interval: zeroFinanceIntervalSchema.default(ZERO_FINANCE_DEFAULT_INTERVAL),
});

export const zeroFinanceOperationSchema = z.enum([
  "search",
  "profile",
  "quote",
  "chart",
]);

export const zeroFinanceResponseSchema = z.object({
  operation: zeroFinanceOperationSchema,
  provider: z.literal("apidojo"),
  billingCategory: z.literal("request"),
  billingQuantity: z.literal(1),
  creditsCharged: z.number().int().nonnegative(),
  result: z.unknown(),
});

export type ZeroFinanceRange = z.infer<typeof zeroFinanceRangeSchema>;
export type ZeroFinanceInterval = z.infer<typeof zeroFinanceIntervalSchema>;
export type ZeroFinanceSearchRequest = z.infer<
  typeof zeroFinanceSearchRequestSchema
>;
export type ZeroFinanceProfileRequest = z.infer<
  typeof zeroFinanceProfileRequestSchema
>;
export type ZeroFinanceQuoteRequest = z.infer<
  typeof zeroFinanceQuoteRequestSchema
>;
export type ZeroFinanceChartRequest = z.infer<
  typeof zeroFinanceChartRequestSchema
>;
export type ZeroFinanceOperation = z.infer<typeof zeroFinanceOperationSchema>;
export type ZeroFinanceResponse = z.infer<typeof zeroFinanceResponseSchema>;

const financeResponses = {
  200: zeroFinanceResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const zeroFinanceContract = c.router({
  search: {
    method: "POST",
    path: "/api/zero/finance/search",
    headers: authHeadersSchema,
    body: zeroFinanceSearchRequestSchema,
    responses: financeResponses,
    summary: "Search financial instruments through managed Zero Finance",
  },
  profile: {
    method: "POST",
    path: "/api/zero/finance/profile",
    headers: authHeadersSchema,
    body: zeroFinanceProfileRequestSchema,
    responses: financeResponses,
    summary: "Fetch a company profile through managed Zero Finance",
  },
  quote: {
    method: "POST",
    path: "/api/zero/finance/quote",
    headers: authHeadersSchema,
    body: zeroFinanceQuoteRequestSchema,
    responses: financeResponses,
    summary: "Fetch a market quote through managed Zero Finance",
  },
  chart: {
    method: "POST",
    path: "/api/zero/finance/chart",
    headers: authHeadersSchema,
    body: zeroFinanceChartRequestSchema,
    responses: financeResponses,
    summary: "Fetch market chart data through managed Zero Finance",
  },
});

export type ZeroFinanceContract = typeof zeroFinanceContract;
