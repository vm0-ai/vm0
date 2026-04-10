import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const featureSwitchesResponseSchema = z.object({
  switches: z.record(z.string(), z.boolean()),
});

export type FeatureSwitchesResponse = z.infer<
  typeof featureSwitchesResponseSchema
>;

export const updateFeatureSwitchesRequestSchema = z.object({
  switches: z.record(z.string(), z.boolean()),
});

export type UpdateFeatureSwitchesRequest = z.infer<
  typeof updateFeatureSwitchesRequestSchema
>;

/**
 * Zero feature switches contract for /api/zero/feature-switches
 *
 * GET: Get current user's feature switch overrides
 * POST: Update user feature switch overrides (merge strategy)
 */
export const zeroFeatureSwitchesContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/feature-switches",
    headers: authHeadersSchema,
    responses: {
      200: featureSwitchesResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get user feature switch overrides",
  },
  update: {
    method: "POST",
    path: "/api/zero/feature-switches",
    headers: authHeadersSchema,
    body: updateFeatureSwitchesRequestSchema,
    responses: {
      200: featureSwitchesResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update user feature switch overrides",
  },
});

export type ZeroFeatureSwitchesContract = typeof zeroFeatureSwitchesContract;
