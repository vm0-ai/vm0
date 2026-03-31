import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { firewallPoliciesSchema } from "./firewalls";

const c = initContract();

/**
 * Custom skill name validation regex.
 * Must be lowercase alphanumeric with hyphens, no leading/trailing hyphens.
 * Minimum 2 characters.
 */
export const zeroAgentCustomSkillNameSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);

/**
 * Zero agent response schema
 */
export const zeroAgentResponseSchema = z.object({
  agentId: z.string(),
  description: z.string().nullable(),
  displayName: z.string().nullable(),
  sound: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  firewallPolicies: firewallPoliciesSchema.nullable(),
  customSkills: z.array(z.string()).default([]),
});

/**
 * Create/update zero agent request schema
 */
export const zeroAgentRequestSchema = z.object({
  description: z.string().optional(),
  displayName: z.string().optional(),
  sound: z.string().optional(),
  avatarUrl: z.string().optional(),
  customSkills: z.array(zeroAgentCustomSkillNameSchema).optional(),
});

/**
 * Partial metadata update request schema (for PATCH)
 */
export const zeroAgentMetadataRequestSchema = z.object({
  displayName: z.string().optional(),
  description: z.string().optional(),
  sound: z.string().optional(),
  avatarUrl: z.string().nullable().optional(),
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
      403: apiErrorSchema,
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
      403: apiErrorSchema,
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
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: zeroAgentResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get zero agent by id",
  },
  update: {
    method: "PUT",
    path: "/api/zero/agents/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: zeroAgentRequestSchema,
    responses: {
      200: zeroAgentResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      422: apiErrorSchema,
    },
    summary: "Update zero agent",
  },
  updateMetadata: {
    method: "PATCH",
    path: "/api/zero/agents/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: zeroAgentMetadataRequestSchema,
    responses: {
      200: zeroAgentResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update zero agent metadata",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/agents/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Delete zero agent by id",
  },
});

/**
 * Update firewall policies request schema
 */
export const zeroAgentFirewallPoliciesRequestSchema = z.object({
  agentId: z.string().uuid(),
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
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: zeroAgentInstructionsResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get zero agent instructions",
  },
  update: {
    method: "PUT",
    path: "/api/zero/agents/:id/instructions",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: zeroAgentInstructionsRequestSchema,
    responses: {
      200: zeroAgentResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      422: apiErrorSchema,
    },
    summary: "Update zero agent instructions",
  },
});

/**
 * Custom skill metadata schema
 */
export const zeroAgentCustomSkillSchema = z.object({
  name: zeroAgentCustomSkillNameSchema,
  displayName: z.string().max(256).nullable(),
  description: z.string().max(1024).nullable(),
});

/**
 * Skill content request schema (create/update)
 */
export const zeroAgentSkillContentRequestSchema = z.object({
  content: z.string(),
});

/**
 * Skill content response schema (get with content)
 */
export const zeroAgentSkillContentResponseSchema = z.object({
  name: z.string(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  content: z.string().nullable(),
});

/**
 * Skill list response schema
 */
export const zeroAgentSkillListResponseSchema = z.array(
  zeroAgentCustomSkillSchema,
);

/**
 * Contract for GET/POST /api/zero/agents/:id/skills (list + create)
 */
export const zeroAgentSkillsCollectionContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/agents/:id/skills",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: zeroAgentSkillListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List custom skills for agent",
  },
  create: {
    method: "POST",
    path: "/api/zero/agents/:id/skills",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: zeroAgentSkillContentRequestSchema.extend({
      name: zeroAgentCustomSkillNameSchema,
      displayName: z.string().max(256).optional(),
      description: z.string().max(1024).optional(),
    }),
    responses: {
      201: zeroAgentCustomSkillSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create custom skill for agent",
  },
});

/**
 * Contract for GET/PUT/DELETE /api/zero/agents/:id/skills/:name
 */
export const zeroAgentSkillsDetailContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/agents/:id/skills/:name",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().uuid(),
      name: zeroAgentCustomSkillNameSchema,
    }),
    responses: {
      200: zeroAgentSkillContentResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get custom skill with content",
  },
  update: {
    method: "PUT",
    path: "/api/zero/agents/:id/skills/:name",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().uuid(),
      name: zeroAgentCustomSkillNameSchema,
    }),
    body: zeroAgentSkillContentRequestSchema,
    responses: {
      200: zeroAgentSkillContentResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update custom skill content",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/agents/:id/skills/:name",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().uuid(),
      name: zeroAgentCustomSkillNameSchema,
    }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete custom skill",
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
export type ZeroAgentCustomSkill = z.infer<typeof zeroAgentCustomSkillSchema>;
export type ZeroAgentSkillContentRequest = z.infer<
  typeof zeroAgentSkillContentRequestSchema
>;
export type ZeroAgentSkillContentResponse = z.infer<
  typeof zeroAgentSkillContentResponseSchema
>;
export type ZeroAgentSkillsCollectionContract =
  typeof zeroAgentSkillsCollectionContract;
export type ZeroAgentSkillsDetailContract =
  typeof zeroAgentSkillsDetailContract;
