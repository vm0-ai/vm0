import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Session response schema
 * Represents a persistent running context across multiple runs
 */
const sessionResponseSchema = z.object({
  id: z.string(),
  agentComposeId: z.string(),
  conversationId: z.string().nullable(),
  artifactNames: z.array(z.string()),
  secretNames: z.array(z.string()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Sessions by ID route contract (/api/agent/sessions/[id])
 */
export const sessionsByIdContract = c.router({
  /**
   * GET /api/agent/sessions/:id
   * Get session by ID
   */
  getById: {
    method: "GET",
    path: "/api/agent/sessions/:id",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Session ID is required"),
    }),
    responses: {
      200: sessionResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get session by ID",
  },
});

export type SessionsByIdContract = typeof sessionsByIdContract;

// Export schemas for reuse
export { sessionResponseSchema };

// Export inferred types for consumers
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
