import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { firewallPoliciesSchema } from "./firewalls";

const c = initContract();

/**
 * Zero agent response schema
 */
export const zeroAgentResponseSchema = z.object({
  agentId: z.string(),
  description: z.string().nullable(),
  displayName: z.string().nullable(),
  sound: z.string().nullable(),
  connectors: z.array(z.string()),
  firewallPolicies: firewallPoliciesSchema.nullable(),
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
 * Partial metadata update request schema (for PATCH)
 */
export const zeroAgentMetadataRequestSchema = z.object({
  displayName: z.string().optional(),
  description: z.string().optional(),
  sound: z.string().optional(),
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
 * Contract for GET/PUT/PATCH/DELETE /api/zero/agents/:id
 */
export const zeroAgentsByIdContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/agents/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string() }),
    responses: {
      200: zeroAgentResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get zero agent by id",
  },
  update: {
    method: "PUT",
    path: "/api/zero/agents/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string() }),
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
  updateMetadata: {
    method: "PATCH",
    path: "/api/zero/agents/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string() }),
    body: zeroAgentMetadataRequestSchema,
    responses: {
      200: zeroAgentResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update zero agent metadata",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/agents/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string() }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete zero agent by id",
  },
});

/**
 * Update firewall policies request schema
 */
export const zeroAgentFirewallPoliciesRequestSchema = z.object({
  agentId: z.string(),
  policies: firewallPoliciesSchema,
});

/**
 * Contract for PUT /api/zero/firewall-policies
 */
export const zeroAgentFirewallPoliciesContract = c.router({
  update: {
    method: "PUT",
    path: "/api/zero/firewall-policies",
    headers: authHeadersSchema,
    body: zeroAgentFirewallPoliciesRequestSchema,
    responses: {
      200: zeroAgentResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update zero agent firewall policies (admin only)",
  },
});

/**
 * Contract for GET/PUT /api/zero/agents/:id/instructions
 */
export const zeroAgentInstructionsContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/agents/:id/instructions",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string() }),
    responses: {
      200: zeroAgentInstructionsResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get zero agent instructions",
  },
  update: {
    method: "PUT",
    path: "/api/zero/agents/:id/instructions",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string() }),
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
export type ZeroAgentMetadataRequest = z.infer<
  typeof zeroAgentMetadataRequestSchema
>;
export type ZeroAgentInstructionsResponse = z.infer<
  typeof zeroAgentInstructionsResponseSchema
>;
export type ZeroAgentInstructionsRequest = z.infer<
  typeof zeroAgentInstructionsRequestSchema
>;
export type ZeroAgentFirewallPoliciesRequest = z.infer<
  typeof zeroAgentFirewallPoliciesRequestSchema
>;

export type ZeroAgentsMainContract = typeof zeroAgentsMainContract;
export type ZeroAgentsByIdContract = typeof zeroAgentsByIdContract;
export type ZeroAgentInstructionsContract =
  typeof zeroAgentInstructionsContract;
export type ZeroAgentFirewallPoliciesContract =
  typeof zeroAgentFirewallPoliciesContract;
