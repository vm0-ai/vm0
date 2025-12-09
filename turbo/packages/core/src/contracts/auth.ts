import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Auth contract for /api/auth/me
 */
export const authContract = c.router({
  /**
   * GET /api/auth/me
   * Get current user information
   */
  me: {
    method: "GET",
    path: "/api/auth/me",
    responses: {
      200: z.object({
        userId: z.string(),
        email: z.string(),
      }),
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get current user information",
  },
});

export type AuthContract = typeof authContract;
