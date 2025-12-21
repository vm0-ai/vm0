import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Agent session schema
 */
const agentSessionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  agentComposeId: z.string(),
  conversationId: z.string().nullable(),
  artifactName: z.string().nullable(), // nullable when session has no artifact
  vars: z.record(z.string(), z.string()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Conversation schema for session with conversation data
 */
const conversationSchema = z.object({
  id: z.string(),
  cliAgentType: z.string(),
  cliAgentSessionId: z.string(),
  cliAgentSessionHistory: z.string(),
});

/**
 * Agent session with conversation data
 */
const agentSessionWithConversationSchema = agentSessionSchema.extend({
  conversation: conversationSchema.nullable(),
});

/**
 * Sessions main route contract (/api/agent/sessions)
 * Handles GET list
 */
export const sessionsMainContract = c.router({
  /**
   * GET /api/agent/sessions
   * List all agent sessions for the authenticated user
   */
  list: {
    method: "GET",
    path: "/api/agent/sessions",
    responses: {
      200: z.object({
        sessions: z.array(agentSessionSchema),
      }),
      401: apiErrorSchema,
    },
    summary: "List agent sessions",
  },
});

/**
 * Sessions by ID route contract (/api/agent/sessions/[id])
 * Handles GET and DELETE
 */
export const sessionsByIdContract = c.router({
  /**
   * GET /api/agent/sessions/:id
   * Get a specific agent session with conversation data
   */
  getById: {
    method: "GET",
    path: "/api/agent/sessions/:id",
    pathParams: z.object({
      id: z.string().min(1, "Session ID is required"),
    }),
    responses: {
      200: z.object({
        session: agentSessionWithConversationSchema,
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent session by ID",
  },
  /**
   * DELETE /api/agent/sessions/:id
   * Delete an agent session
   */
  delete: {
    method: "DELETE",
    path: "/api/agent/sessions/:id",
    pathParams: z.object({
      id: z.string().min(1, "Session ID is required"),
    }),
    body: z.undefined(),
    responses: {
      200: z.object({
        deleted: z.literal(true),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete agent session",
  },
});

export type SessionsMainContract = typeof sessionsMainContract;
export type SessionsByIdContract = typeof sessionsByIdContract;

// Export schemas for reuse
export {
  agentSessionSchema,
  conversationSchema,
  agentSessionWithConversationSchema,
};
