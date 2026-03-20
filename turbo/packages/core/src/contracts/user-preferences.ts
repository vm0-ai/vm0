import { z } from "zod";

/**
 * User preferences response
 */
export const sendModeSchema = z.enum(["enter", "cmd-enter"]);
export type SendMode = z.infer<typeof sendModeSchema>;

export const userPreferencesResponseSchema = z.object({
  timezone: z.string().nullable(),
  notifyEmail: z.boolean(),
  notifySlack: z.boolean(),
  pinnedAgentIds: z.array(z.string()),
  sendMode: sendModeSchema,
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
    notifySlack: z.boolean().optional(),
    pinnedAgentIds: z.array(z.string()).optional(),
    sendMode: sendModeSchema.optional(),
  })
  .refine(
    (data) =>
      data.timezone !== undefined ||
      data.notifyEmail !== undefined ||
      data.notifySlack !== undefined ||
      data.pinnedAgentIds !== undefined ||
      data.sendMode !== undefined,
    {
      message: "At least one preference must be provided",
    },
  );

export type UpdateUserPreferencesRequest = z.infer<
  typeof updateUserPreferencesRequestSchema
>;
