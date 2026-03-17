import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  modelProviderListResponseSchema,
  upsertModelProviderRequestSchema,
  upsertModelProviderResponseSchema,
  modelProviderResponseSchema,
  modelProviderTypeSchema,
  updateModelRequestSchema,
} from "./model-providers";

const c = initContract();

/**
 * Org model providers main contract for /api/org/model-providers
 *
 * GET: List org-level model providers (any member)
 * PUT: Create or update an org-level model provider (admin only)
 */
export const orgModelProvidersMainContract = c.router({
  list: {
    method: "GET",
    path: "/api/org/model-providers",
    headers: authHeadersSchema,
    responses: {
      200: modelProviderListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List org-level model providers",
  },
  upsert: {
    method: "PUT",
    path: "/api/org/model-providers",
    headers: authHeadersSchema,
    body: upsertModelProviderRequestSchema,
    responses: {
      200: upsertModelProviderResponseSchema,
      201: upsertModelProviderResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create or update an org-level model provider (admin only)",
  },
});

export type OrgModelProvidersMainContract =
  typeof orgModelProvidersMainContract;

/**
 * Org model providers by type contract for /api/org/model-providers/:type
 *
 * DELETE: Delete an org-level model provider (admin only)
 */
export const orgModelProvidersByTypeContract = c.router({
  delete: {
    method: "DELETE",
    path: "/api/org/model-providers/:type",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: modelProviderTypeSchema,
    }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete an org-level model provider (admin only)",
  },
});

export type OrgModelProvidersByTypeContract =
  typeof orgModelProvidersByTypeContract;

/**
 * Org model providers set default contract for /api/org/model-providers/:type/set-default
 *
 * POST: Set org-level model provider as default (admin only)
 */
export const orgModelProvidersSetDefaultContract = c.router({
  setDefault: {
    method: "POST",
    path: "/api/org/model-providers/:type/set-default",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: modelProviderTypeSchema,
    }),
    body: z.undefined(),
    responses: {
      200: modelProviderResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Set org-level model provider as default (admin only)",
  },
});

export type OrgModelProvidersSetDefaultContract =
  typeof orgModelProvidersSetDefaultContract;

/**
 * Org model providers update model contract for /api/org/model-providers/:type/model
 *
 * PATCH: Update model selection for org-level provider (admin only)
 */
export const orgModelProvidersUpdateModelContract = c.router({
  updateModel: {
    method: "PATCH",
    path: "/api/org/model-providers/:type/model",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: modelProviderTypeSchema,
    }),
    body: updateModelRequestSchema,
    responses: {
      200: modelProviderResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update model selection for org-level provider (admin only)",
  },
});

export type OrgModelProvidersUpdateModelContract =
  typeof orgModelProvidersUpdateModelContract;
