import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

// Zero always asks Browser Use for its longest provider lifetime and manages
// reclamation itself through the idle lease below, so a hard provider timeout
// can never cut a browser short while somebody is still using it.
export const ZERO_BROWSER_PROVIDER_TIMEOUT_MINUTES = 240;
export const ZERO_BROWSER_IDLE_LEASE_MINUTES = 10;
export const ZERO_BROWSER_DEFAULT_MAX_CREDITS = 500;
export const ZERO_BROWSER_MAX_CREDITS = 100_000;
export const ZERO_BROWSER_SCREEN_WIDTH = 1440;
export const ZERO_BROWSER_INITIAL_SCREEN_HEIGHT = 900;
export const ZERO_BROWSER_MIN_SCREEN_HEIGHT = 320;
export const ZERO_BROWSER_MAX_SCREEN_HEIGHT = 3456;

export const zeroBrowserStatusSchema = z.enum([
  "creating",
  "active",
  "resuming",
  "stopping",
  "suspended",
  "error",
]);

export const zeroBrowserSuspensionReasonSchema = z.enum([
  // Historical reason kept for rows written before the idle lease existed.
  "run_end",
  "idle",
  "timeout",
  "budget",
  "provider",
  "reconcile",
]);

const zeroBrowserScreenSchema = z.object({
  width: z.literal(ZERO_BROWSER_SCREEN_WIDTH),
  height: z
    .number()
    .int()
    .min(ZERO_BROWSER_MIN_SCREEN_HEIGHT)
    .max(ZERO_BROWSER_MAX_SCREEN_HEIGHT),
  resizable: z.boolean(),
});

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
  // Optional so a newly deployed frontend remains compatible with the
  // previous API during rollout. New APIs include it for live instances.
  screen: zeroBrowserScreenSchema.optional(),
  // When Zero reclaims the live provider instance unless somebody leases it
  // again. Null once no provider instance is running.
  idleExpiresAt: z.iso.datetime().nullable(),
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

const browserResizeRequestSchema = z.object({
  aspectRatio: z.number().positive().finite(),
});

const browserAuthorizationRequestTokenPathParamsSchema = z.object({
  requestToken: z.string().min(1),
});

const browserAuthorizationRequestCreateResponseSchema = z.object({
  authorizationUrl: z.url(),
  expiresAt: z.iso.datetime(),
});

const browserAuthorizationRequestResponseSchema = z.object({
  expiresAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  cloudBrowserEnabled: z.boolean(),
});

const browserAuthorizationRequestApplyResponseSchema = z.object({
  ok: z.literal(true),
  cloudBrowserEnabled: z.literal(true),
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
      "Create a new managed browser for the current chat thread using its isolated profile",
  },
  use: {
    method: "POST",
    path: "/api/zero/browsers/use",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: browserConnectionResponseSchema,
      ...commonErrorResponses,
    },
    summary:
      "Create, reuse, or resume the current chat thread's managed browser and extend its idle lease",
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
    summary:
      "Compatibility alias of use for CLI versions that predate zero browser use",
  },
  lease: {
    method: "POST",
    path: "/api/zero/browsers/lease",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: browserResponseSchema,
      ...commonErrorResponses,
    },
    summary: "Extend the idle lease of the current chat thread's live browser",
  },
  leaseById: {
    method: "POST",
    path: "/api/zero/browsers/:browserId/lease",
    headers: authHeadersSchema,
    pathParams: browserIdParamsSchema,
    body: z.object({}),
    responses: {
      200: browserResponseSchema,
      ...commonErrorResponses,
    },
    summary: "Extend the idle lease of a live browser from its viewer",
  },
  resumeById: {
    method: "POST",
    path: "/api/zero/browsers/:browserId/resume",
    headers: authHeadersSchema,
    pathParams: browserIdParamsSchema,
    body: z.object({}),
    responses: {
      200: browserResponseSchema,
      ...commonErrorResponses,
    },
    summary: "Resume a suspended browser from its viewer and start billing it",
  },
  resizeById: {
    method: "POST",
    path: "/api/zero/browsers/:browserId/resize",
    headers: authHeadersSchema,
    pathParams: browserIdParamsSchema,
    body: browserResizeRequestSchema,
    responses: {
      200: browserResponseSchema,
      ...commonErrorResponses,
    },
    summary: "Resize a live browser to match a viewer aspect ratio",
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
    } as const,
    summary: "Get a managed browser by universal-link ID",
  },
});

export const zeroBrowserAuthorizationRequestsContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/browser/authorization-requests",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: browserAuthorizationRequestCreateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary:
      "Create a short-lived cloud browser authorization request for the current run",
  },
  get: {
    method: "GET",
    path: "/api/zero/browser/authorization-requests/:requestToken",
    headers: authHeadersSchema,
    pathParams: browserAuthorizationRequestTokenPathParamsSchema,
    responses: {
      200: browserAuthorizationRequestResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      410: apiErrorSchema,
    },
    summary: "Read a cloud browser authorization request",
  },
  apply: {
    method: "POST",
    path: "/api/zero/browser/authorization-requests/:requestToken/apply",
    headers: authHeadersSchema,
    pathParams: browserAuthorizationRequestTokenPathParamsSchema,
    body: z.object({}),
    responses: {
      200: browserAuthorizationRequestApplyResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      410: apiErrorSchema,
    },
    summary: "Enable the cloud browser for a delegated authorization request",
  },
});

export type ZeroBrowserContract = typeof zeroBrowserContract;
export type ZeroBrowserAuthorizationRequestsContract =
  typeof zeroBrowserAuthorizationRequestsContract;
export type BrowserAuthorizationRequestCreateResponse = z.infer<
  typeof browserAuthorizationRequestCreateResponseSchema
>;
export type BrowserAuthorizationRequestResponse = z.infer<
  typeof browserAuthorizationRequestResponseSchema
>;
export type BrowserAuthorizationRequestApplyResponse = z.infer<
  typeof browserAuthorizationRequestApplyResponseSchema
>;
