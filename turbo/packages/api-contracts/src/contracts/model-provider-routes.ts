import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  modelProviderListResponseSchema,
  upsertModelProviderRequestSchema,
  upsertModelProviderResponseSchema,
  modelProviderTypeSchema,
} from "./model-providers";

const c = initContract();
const orgUpsertModelProviderRequestSchema =
  upsertModelProviderRequestSchema.omit({ selectedModel: true });

/**
 * Model providers main contract for /api/model-providers
 *
 * GET: List org-level model providers (any member)
 * POST: Create or update an org-level model provider (admin only)
 */
export const modelProvidersMainContract = c.router({
  list: {
    method: "GET",
    path: "/api/model-providers",
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
    path: "/api/model-providers",
    headers: authHeadersSchema,
    body: orgUpsertModelProviderRequestSchema,
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

export type ModelProvidersMainContract = typeof modelProvidersMainContract;

/**
 * Model providers by type contract for /api/model-providers/:type
 *
 * DELETE: Delete an org-level model provider (admin only)
 */
export const modelProvidersByTypeContract = c.router({
  delete: {
    method: "DELETE",
    path: "/api/model-providers/:type",
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

export type ModelProvidersByTypeContract = typeof modelProvidersByTypeContract;
