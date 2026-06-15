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
