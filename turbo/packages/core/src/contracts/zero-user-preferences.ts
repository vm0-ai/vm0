import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import {
  userPreferencesResponseSchema,
  updateUserPreferencesRequestSchema,
} from "./user-preferences";

const c = initContract();

/**
 * Zero user preferences contract for /api/zero/user-preferences
 *
 * GET: Get current user's preferences
 * POST: Update user preferences
 */
export const zeroUserPreferencesContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/user-preferences",
    headers: authHeadersSchema,
    responses: {
      200: userPreferencesResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get user preferences",
  },
  update: {
    method: "POST",
    path: "/api/zero/user-preferences",
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

export type ZeroUserPreferencesContract = typeof zeroUserPreferencesContract;
