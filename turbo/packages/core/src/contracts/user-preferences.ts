import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * User preferences response
 */
export const userPreferencesResponseSchema = z.object({
  timezone: z.string().nullable(),
  notifyEmail: z.boolean(),
});

export type UserPreferencesResponse = z.infer<
  typeof userPreferencesResponseSchema
>;

/**
 * Update user preferences request
 */
export const updateUserPreferencesRequestSchema = z
  .object({
    timezone: z.string().min(1).optional(),
    notifyEmail: z.boolean().optional(),
  })
  .refine(
    (data) => data.timezone !== undefined || data.notifyEmail !== undefined,
    {
      message: "At least one preference must be provided",
    },
  );

export type UpdateUserPreferencesRequest = z.infer<
  typeof updateUserPreferencesRequestSchema
>;

/**
 * User preferences contract for /api/user/preferences
 */
export const userPreferencesContract = c.router({
  /**
   * GET /api/user/preferences
   * Get current user's preferences
   */
  get: {
    method: "GET",
    path: "/api/user/preferences",
    headers: authHeadersSchema,
    responses: {
      200: userPreferencesResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get user preferences",
  },

  /**
   * PUT /api/user/preferences
   * Update user preferences
   */
  update: {
    method: "PUT",
    path: "/api/user/preferences",
    headers: authHeadersSchema,
    body: updateUserPreferencesRequestSchema,
    responses: {
      200: userPreferencesResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update user preferences",
  },
});

export type UserPreferencesContract = typeof userPreferencesContract;
