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

/**
 * Zero personal (user-level) model providers main contract for /api/zero/me/model-providers
 *
 * Personal-tier per Epic #11868: providers scoped to the authenticated user
 * within an org, no admin gate. List/upsert are gated on model-first provider
 * controls and return 404 when unavailable.
 *
 * GET: List the requesting user's personal model providers
 * POST: Create or update a personal model provider for the requesting user
 */
export const zeroPersonalModelProvidersMainContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/me/model-providers",
    headers: authHeadersSchema,
    responses: {
      200: modelProviderListResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List the requesting user's personal model providers",
  },
  upsert: {
    method: "POST",
    path: "/api/zero/me/model-providers",
    headers: authHeadersSchema,
    body: upsertModelProviderRequestSchema,
    responses: {
      200: upsertModelProviderResponseSchema,
      201: upsertModelProviderResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Create or update a personal model provider for the requesting user",
  },
});

export type ZeroPersonalModelProvidersMainContract =
  typeof zeroPersonalModelProvidersMainContract;

/**
 * Zero personal model providers by type contract for /api/zero/me/model-providers/:type
 *
 * DELETE: Delete one of the requesting user's personal model providers
 */
export const zeroPersonalModelProvidersByTypeContract = c.router({
  delete: {
    method: "DELETE",
    path: "/api/zero/me/model-providers/:type",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: modelProviderTypeSchema,
    }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete a personal model provider for the requesting user",
  },
});

export type ZeroPersonalModelProvidersByTypeContract =
  typeof zeroPersonalModelProvidersByTypeContract;
