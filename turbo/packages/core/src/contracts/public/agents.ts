/**
 * Public API v1 - Agents Contract
 *
 * Agent endpoints for the developer-friendly public API.
 * Maps internal "composes" to public "agents" naming.
 */
import { z } from "zod";
import { initContract } from "../base";
import {
  publicApiErrorSchema,
  createPaginatedResponseSchema,
  listQuerySchema,
  timestampSchema,
} from "./common";

const c = initContract();

/**
 * Agent schema for public API responses
 */
export const publicAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  current_version_id: z.string().nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

export type PublicAgent = z.infer<typeof publicAgentSchema>;

/**
 * Agent version schema
 */
export const agentVersionSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  version_number: z.number(),
  config: z.unknown(), // Agent YAML configuration
  created_at: timestampSchema,
});

export type AgentVersion = z.infer<typeof agentVersionSchema>;

/**
 * Agent detail schema (includes config)
 */
export const publicAgentDetailSchema = publicAgentSchema.extend({
  config: z.unknown().optional(),
});

export type PublicAgentDetail = z.infer<typeof publicAgentDetailSchema>;

/**
 * Paginated agents response
 */
export const paginatedAgentsSchema =
  createPaginatedResponseSchema(publicAgentSchema);

/**
 * Paginated agent versions response
 */
export const paginatedAgentVersionsSchema =
  createPaginatedResponseSchema(agentVersionSchema);

/**
 * Update agent request schema
 */
export const updateAgentRequestSchema = z.object({
  config: z.unknown(), // New agent configuration (creates new version)
});

export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;

/**
 * Agent list query parameters
 */
export const agentListQuerySchema = listQuerySchema.extend({
  name: z.string().optional(),
});

export type AgentListQuery = z.infer<typeof agentListQuerySchema>;

/**
 * Agents list contract - GET /v1/agents
 */
export const publicAgentsListContract = c.router({
  list: {
    method: "GET",
    path: "/v1/agents",
    query: agentListQuerySchema,
    responses: {
      200: paginatedAgentsSchema,
      401: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "List agents",
    description:
      "List all agents in the current scope with pagination. Use the `name` query parameter to filter by agent name.",
  },
});

/**
 * Agent by ID contract - GET/PUT /v1/agents/:id
 */
export const publicAgentByIdContract = c.router({
  get: {
    method: "GET",
    path: "/v1/agents/:id",
    pathParams: z.object({
      id: z.string().min(1, "Agent ID is required"),
    }),
    responses: {
      200: publicAgentDetailSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Get agent",
    description: "Get agent details by ID",
  },
  update: {
    method: "PUT",
    path: "/v1/agents/:id",
    pathParams: z.object({
      id: z.string().min(1, "Agent ID is required"),
    }),
    body: updateAgentRequestSchema,
    responses: {
      200: publicAgentDetailSchema,
      400: publicApiErrorSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Update agent",
    description:
      "Update agent configuration. Creates a new version if config changes.",
  },
});

/**
 * Agent versions contract - GET /v1/agents/:id/versions
 */
export const publicAgentVersionsContract = c.router({
  list: {
    method: "GET",
    path: "/v1/agents/:id/versions",
    pathParams: z.object({
      id: z.string().min(1, "Agent ID is required"),
    }),
    query: listQuerySchema,
    responses: {
      200: paginatedAgentVersionsSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "List agent versions",
    description: "List all versions of an agent with pagination",
  },
});

export type PublicAgentsListContract = typeof publicAgentsListContract;
export type PublicAgentByIdContract = typeof publicAgentByIdContract;
export type PublicAgentVersionsContract = typeof publicAgentVersionsContract;
