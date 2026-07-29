import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

// Zero always asks Browser Use for its longest provider lifetime and manages
// reclamation itself through the idle lease below, so a hard provider timeout
// can never cut a browser short while somebody is still using it.
export const ZERO_BROWSER_PROVIDER_TIMEOUT_MINUTES = 240;
export const ZERO_BROWSER_IDLE_LEASE_MINUTES = 10;

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
  // Historical reason kept for rows written before browser billing was removed.
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
    summary: "Resume a suspended browser from its viewer",
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
