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
 * Zero model providers main contract for /api/zero/model-providers
 *
 * GET: List org-level model providers (any member)
 * POST: Create or update an org-level model provider (admin only)
 */
export const zeroModelProvidersMainContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/model-providers",
    headers: authHeadersSchema,
    responses: {
      200: modelProviderListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List org-level model providers",
  },
  upsert: {
    method: "POST",
    path: "/api/zero/model-providers",
    headers: authHeadersSchema,
    body: upsertModelProviderRequestSchema,
    responses: {
      200: upsertModelProviderResponseSchema,
      201: upsertModelProviderResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create or update an org-level model provider (admin only)",
  },
});

export type ZeroModelProvidersMainContract =
  typeof zeroModelProvidersMainContract;

/**
 * Zero model providers by type contract for /api/zero/model-providers/:type
 *
 * DELETE: Delete an org-level model provider (admin only)
 */
export const zeroModelProvidersByTypeContract = c.router({
  delete: {
    method: "DELETE",
    path: "/api/zero/model-providers/:type",
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

export type ZeroModelProvidersByTypeContract =
  typeof zeroModelProvidersByTypeContract;

/**
 * Zero model providers default contract for /api/zero/model-providers/:type/default
 *
 * POST: Set org-level model provider as default (admin only)
 */
export const zeroModelProvidersDefaultContract = c.router({
  setDefault: {
    method: "POST",
    path: "/api/zero/model-providers/:type/default",
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

export type ZeroModelProvidersDefaultContract =
  typeof zeroModelProvidersDefaultContract;

/**
 * Zero model providers update model contract for /api/zero/model-providers/:type/model
 *
 * PATCH: Update model selection for org-level provider (admin only)
 */
export const zeroModelProvidersUpdateModelContract = c.router({
  updateModel: {
    method: "PATCH",
    path: "/api/zero/model-providers/:type/model",
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

export type ZeroModelProvidersUpdateModelContract =
  typeof zeroModelProvidersUpdateModelContract;
