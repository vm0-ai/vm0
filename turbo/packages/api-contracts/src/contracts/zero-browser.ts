import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const ZERO_BROWSER_DEFAULT_TIMEOUT_MINUTES = 30;
export const ZERO_BROWSER_MAX_TIMEOUT_MINUTES = 240;
export const ZERO_BROWSER_DEFAULT_MAX_CREDITS = 500;
export const ZERO_BROWSER_MAX_CREDITS = 100_000;

export const zeroBrowserStatusSchema = z.enum([
  "creating",
  "active",
  "resuming",
  "stopping",
  "suspended",
  "error",
]);

export const zeroBrowserSuspensionReasonSchema = z.enum([
  "run_end",
  "timeout",
  "budget",
  "provider",
  "reconcile",
]);

export const zeroBrowserSessionSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(64),
  status: zeroBrowserStatusSchema,
  viewerUrl: z.url(),
  liveUrl: z.url().nullable(),
  proxyCountryCode: z.string().length(2).nullable(),
  timeoutMinutes: z.number().int().positive(),
  maxCredits: z.number().int().positive(),
  grossCredits: z.number().int().nonnegative(),
  creditsCharged: z.number().int().nonnegative(),
  suspendedAt: z.iso.datetime().nullable(),
  suspensionReason: zeroBrowserSuspensionReasonSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type ZeroBrowserStatus = z.infer<typeof zeroBrowserStatusSchema>;
export type ZeroBrowserSuspensionReason = z.infer<
  typeof zeroBrowserSuspensionReasonSchema
>;
export type ZeroBrowserSession = z.infer<typeof zeroBrowserSessionSchema>;

export const zeroBrowserCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).default("browser"),
  proxyCountryCode: z
    .string()
    .trim()
    .length(2)
    .transform((value) => {
      return value.toLowerCase();
    })
    .nullable()
    .default(null),
  timeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(ZERO_BROWSER_MAX_TIMEOUT_MINUTES)
    .default(ZERO_BROWSER_DEFAULT_TIMEOUT_MINUTES),
  maxCredits: z
    .number()
    .int()
    .min(1)
    .max(ZERO_BROWSER_MAX_CREDITS)
    .default(ZERO_BROWSER_DEFAULT_MAX_CREDITS),
});

export type ZeroBrowserCreateRequest = z.infer<
  typeof zeroBrowserCreateRequestSchema
>;

const browserIdParamsSchema = z.object({
  browserId: z.uuid(),
});

const browserGetQuerySchema = z.object({
  chatThreadId: z.uuid().optional(),
});

const browserResponseSchema = z.object({
  browser: zeroBrowserSessionSchema,
});

const browserConnectionResponseSchema = browserResponseSchema.extend({
  cdpUrl: z.url(),
});

const commonErrorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const zeroBrowserContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/browsers",
    headers: authHeadersSchema,
    body: zeroBrowserCreateRequestSchema,
    responses: {
      201: browserConnectionResponseSchema,
      ...commonErrorResponses,
    },
    summary:
      "Create a new managed browser for the current chat thread using the user's shared profile",
  },
  resume: {
    method: "POST",
    path: "/api/zero/browsers/resume",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: browserConnectionResponseSchema,
      ...commonErrorResponses,
    },
    summary: "Resume the current chat thread's managed browser",
  },
  current: {
    method: "GET",
    path: "/api/zero/browsers/current",
    headers: authHeadersSchema,
    responses: {
      200: browserResponseSchema,
      ...commonErrorResponses,
    },
    summary: "Get the current chat thread's managed browser",
  },
  get: {
    method: "GET",
    path: "/api/zero/browsers/:browserId",
    headers: authHeadersSchema,
    pathParams: browserIdParamsSchema,
    query: browserGetQuerySchema,
    responses: {
      200: browserResponseSchema,
      ...commonErrorResponses,
    },
    summary: "Get a managed browser by universal-link ID",
  },
});

export type ZeroBrowserContract = typeof zeroBrowserContract;
