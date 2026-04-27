import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * User preferences schemas (shared across contracts)
 */
export const sendModeSchema = z.enum(["enter", "cmd-enter"]);
export type SendMode = z.infer<typeof sendModeSchema>;

export const userPreferencesResponseSchema = z.object({
  timezone: z.string().nullable(),
  pinnedAgentIds: z.array(z.string()),
  sendMode: sendModeSchema,
  captureNetworkBodiesRemaining: z.number().int().min(0),
});

export type UserPreferencesResponse = z.infer<
  typeof userPreferencesResponseSchema
>;

export const updateUserPreferencesRequestSchema = z
  .object({
    timezone: z.string().min(1).optional(),
    pinnedAgentIds: z.array(z.string()).optional(),
    sendMode: sendModeSchema.optional(),
    captureNetworkBodiesRemaining: z.number().int().min(0).optional(),
  })
  .refine(
    (data) => {
      return (
        data.timezone !== undefined ||
        data.pinnedAgentIds !== undefined ||
        data.sendMode !== undefined ||
        data.captureNetworkBodiesRemaining !== undefined
      );
    },
    {
      message: "At least one preference must be provided",
    },
  );

export type UpdateUserPreferencesRequest = z.infer<
  typeof updateUserPreferencesRequestSchema
>;

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
