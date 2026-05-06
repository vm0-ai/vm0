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
 * Zero personal (user-level) model providers main contract for /api/zero/me/model-providers
 *
 * Personal-tier per Epic #11868: providers scoped to the authenticated user
 * within an org, no admin gate. Endpoints are gated on the
 * `personalModelProvider` feature switch and return 404 when off.
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

/**
 * Zero personal model providers default contract for /api/zero/me/model-providers/:type/default
 *
 * POST: Set one of the requesting user's personal providers as their default
 */
export const zeroPersonalModelProvidersDefaultContract = c.router({
  setDefault: {
    method: "POST",
    path: "/api/zero/me/model-providers/:type/default",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: modelProviderTypeSchema,
    }),
    body: z.undefined(),
    responses: {
      200: modelProviderResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Set a personal model provider as the user's default",
  },
});

export type ZeroPersonalModelProvidersDefaultContract =
  typeof zeroPersonalModelProvidersDefaultContract;

/**
 * Zero personal model providers update model contract for /api/zero/me/model-providers/:type/model
 *
 * PATCH: Update model selection for one of the user's personal providers
 */
export const zeroPersonalModelProvidersUpdateModelContract = c.router({
  updateModel: {
    method: "PATCH",
    path: "/api/zero/me/model-providers/:type/model",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: modelProviderTypeSchema,
    }),
    body: updateModelRequestSchema,
    responses: {
      200: modelProviderResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update model selection for a personal model provider",
  },
});

export type ZeroPersonalModelProvidersUpdateModelContract =
  typeof zeroPersonalModelProvidersUpdateModelContract;
