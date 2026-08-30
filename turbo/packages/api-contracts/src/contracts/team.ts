import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { agentVisibilitySchema } from "./agents";

const c = initContract();

const teamComposeItemSchema = z.object({
  id: z.string(),
  ownerId: z.string().optional(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  sound: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  visibility: agentVisibilitySchema.optional(),
  updatedAt: z.string(),
});

/**
 * Team contract (GET /api/team)
 * Lists all agents in the user's active Clerk org.
 */
export const teamContract = c.router({
  list: {
    method: "GET",
    path: "/api/team",
    headers: authHeadersSchema,
    responses: {
      200: z.array(teamComposeItemSchema),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List all agents in the user's active org",
  },
});

export type TeamContract = typeof teamContract;
export type TeamComposeItem = z.infer<typeof teamComposeItemSchema>;
export { teamComposeItemSchema };
