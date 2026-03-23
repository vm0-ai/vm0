import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Zero agent response schema
 */
export const zeroAgentResponseSchema = z.object({
  name: z.string(),
  agentComposeId: z.string(),
  description: z.string().nullable(),
  displayName: z.string().nullable(),
  sound: z.string().nullable(),
  connectors: z.array(z.string()),
});

/**
 * Create/update zero agent request schema
 */
export const zeroAgentRequestSchema = z.object({
  description: z.string().optional(),
  displayName: z.string().optional(),
  sound: z.string().optional(),
  connectors: z.array(z.string()),
});

/**
 * Zero agent instructions response schema
 */
export const zeroAgentInstructionsResponseSchema = z.object({
  content: z.string().nullable(),
  filename: z.string().nullable(),
});

/**
 * Zero agent instructions update request schema
 */
export const zeroAgentInstructionsRequestSchema = z.object({
  content: z.string(),
});

/**
 * Contract for GET/POST /api/zero/agents (list/create agents)
 */
export const zeroAgentsMainContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/agents",
    headers: authHeadersSchema,
    body: zeroAgentRequestSchema,
    responses: {
      201: zeroAgentResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      422: apiErrorSchema,
    },
    summary: "Create zero agent",
  },
  list: {
    method: "GET",
    path: "/api/zero/agents",
    headers: authHeadersSchema,
    responses: {
      200: z.array(zeroAgentResponseSchema),
      401: apiErrorSchema,
    },
    summary: "List zero agents",
  },
});

/**
 * Contract for GET/PUT/DELETE /api/zero/agents/:name
 */
export const zeroAgentsByNameContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/agents/:name",
    headers: authHeadersSchema,
    pathParams: z.object({ name: z.string() }),
    responses: {
      200: zeroAgentResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get zero agent by name",
  },
  update: {
    method: "PUT",
    path: "/api/zero/agents/:name",
    headers: authHeadersSchema,
    pathParams: z.object({ name: z.string() }),
    body: zeroAgentRequestSchema,
    responses: {
      200: zeroAgentResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      422: apiErrorSchema,
    },
    summary: "Update zero agent",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/agents/:name",
    headers: authHeadersSchema,
    pathParams: z.object({ name: z.string() }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete zero agent by name",
  },
});

/**
 * Contract for GET/PUT /api/zero/agents/:name/instructions
 */
export const zeroAgentInstructionsContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/agents/:name/instructions",
    headers: authHeadersSchema,
    pathParams: z.object({ name: z.string() }),
    responses: {
      200: zeroAgentInstructionsResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get zero agent instructions",
  },
  update: {
    method: "PUT",
    path: "/api/zero/agents/:name/instructions",
    headers: authHeadersSchema,
    pathParams: z.object({ name: z.string() }),
    body: zeroAgentInstructionsRequestSchema,
    responses: {
      200: zeroAgentResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      422: apiErrorSchema,
    },
    summary: "Update zero agent instructions",
  },
});

// Export types
export type ZeroAgentResponse = z.infer<typeof zeroAgentResponseSchema>;
export type ZeroAgentRequest = z.infer<typeof zeroAgentRequestSchema>;
export type ZeroAgentInstructionsResponse = z.infer<
  typeof zeroAgentInstructionsResponseSchema
>;
export type ZeroAgentInstructionsRequest = z.infer<
  typeof zeroAgentInstructionsRequestSchema
>;

export type ZeroAgentsMainContract = typeof zeroAgentsMainContract;
export type ZeroAgentsByNameContract = typeof zeroAgentsByNameContract;
export type ZeroAgentInstructionsContract =
  typeof zeroAgentInstructionsContract;
