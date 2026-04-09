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
  ownerId: z.string(),
  description: z.string().nullable(),
  displayName: z.string().nullable(),
  sound: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  permissionPolicies: firewallPoliciesSchema.nullable(),
  allowUnknownEndpoints: z.record(z.string(), z.boolean()).nullable(),
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
 * Update permission policies request schema
 */
export const zeroAgentPermissionPoliciesRequestSchema = z.object({
  agentId: z.string().uuid(),
  policies: firewallPoliciesSchema,
  allowUnknownEndpoints: z.record(z.string(), z.boolean()).optional(),
});

/**
 * Contract for PUT /api/zero/permission-policies
 */
export const zeroAgentPermissionPoliciesContract = c.router({
  update: {
    method: "PUT",
    path: "/api/zero/permission-policies",
    headers: authHeadersSchema,
    body: zeroAgentPermissionPoliciesRequestSchema,
    responses: {
      200: zeroAgentResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update zero agent permission policies (owner only)",
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
 * Single file entry in a skill upload
 */
export const skillFileEntrySchema = z.object({
  path: z
    .string()
    .min(1)
    .max(256)
    .refine(
      (p) => {
        return !p.startsWith("/");
      },
      { message: "Path must be relative" },
    )
    .refine(
      (p) => {
        return !p.includes("..");
      },
      {
        message: "Path must not contain ..",
      },
    ),
  content: z.string(),
});

/**
 * Total size limit for all skill files combined (5MB)
 */
const SKILL_FILES_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Maximum number of files in a single skill upload
 */
const SKILL_FILES_MAX_COUNT = 500;

/**
 * Skill files request schema (create/update)
 */
export const zeroAgentSkillFilesRequestSchema = z.object({
  files: z
    .array(skillFileEntrySchema)
    .min(1, "At least one file is required")
    .max(
      SKILL_FILES_MAX_COUNT,
      `Maximum ${SKILL_FILES_MAX_COUNT} files allowed`,
    )
    .refine(
      (files) => {
        return files.some((f) => {
          return f.path === "SKILL.md";
        });
      },
      {
        message: "SKILL.md is required",
      },
    )
    .refine(
      (files) => {
        const total = files.reduce((sum, f) => {
          return sum + new TextEncoder().encode(f.content).length;
        }, 0);
        return total <= SKILL_FILES_MAX_BYTES;
      },
      { message: "Total file size must not exceed 5MB" },
    ),
});

/**
 * File metadata in skill response (path + size, no content)
 */
export const skillFileMetadataSchema = z.object({
  path: z.string(),
  size: z.number(),
});

/**
 * Skill content response schema (get with content)
 */
export const zeroAgentSkillContentResponseSchema = z.object({
  name: z.string(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  content: z.string().nullable(),
  files: z.array(skillFileMetadataSchema).nullable(),
});

/**
 * Skill list response schema
 */
export const zeroAgentSkillListResponseSchema = z.array(
  zeroAgentCustomSkillSchema,
);

/**
 * Contract for GET/POST /api/zero/skills (list + create org-level skills)
 */
export const zeroSkillsCollectionContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/skills",
    headers: authHeadersSchema,
    responses: {
      200: zeroAgentSkillListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List all custom skills in the organization",
  },
  create: {
    method: "POST",
    path: "/api/zero/skills",
    headers: authHeadersSchema,
    body: zeroAgentSkillFilesRequestSchema.extend({
      name: zeroAgentCustomSkillNameSchema,
      displayName: z.string().max(256).optional(),
      description: z.string().max(1024).optional(),
    }),
    responses: {
      201: zeroAgentCustomSkillSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create a custom skill in the organization",
  },
});

/**
 * Contract for GET/PUT/DELETE /api/zero/skills/:name (org-level skill detail)
 */
export const zeroSkillsDetailContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/skills/:name",
    headers: authHeadersSchema,
    pathParams: z.object({ name: zeroAgentCustomSkillNameSchema }),
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
    path: "/api/zero/skills/:name",
    headers: authHeadersSchema,
    pathParams: z.object({ name: zeroAgentCustomSkillNameSchema }),
    body: zeroAgentSkillFilesRequestSchema,
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
    path: "/api/zero/skills/:name",
    headers: authHeadersSchema,
    pathParams: z.object({ name: zeroAgentCustomSkillNameSchema }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete custom skill from the organization",
  },
});

/**
 * Permission access request status
 */
export const permissionAccessRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
]);

/**
 * Permission access request response schema
 */
const permissionAccessRequestActionSchema = z.enum(["allow", "deny"]);

export const permissionAccessRequestResponseSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  connectorRef: z.string(),
  permission: z.string(),
  action: permissionAccessRequestActionSchema,
  method: z.string().nullable(),
  path: z.string().nullable(),
  reason: z.string().nullable(),
  status: permissionAccessRequestStatusSchema,
  requesterUserId: z.string(),
  requesterName: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});

/**
 * Create permission access request body
 */
export const createPermissionAccessRequestSchema = z.object({
  agentId: z.string().uuid(),
  connectorRef: z.string(),
  permission: z.string(),
  action: permissionAccessRequestActionSchema.optional().default("allow"),
  method: z.string().optional(),
  path: z.string().optional(),
  reason: z.string().optional(),
});

/**
 * Resolve permission access request body
 */
export const resolvePermissionAccessRequestSchema = z.object({
  requestId: z.string().uuid(),
  action: z.enum(["approve", "reject"]),
});

/**
 * Contract for POST /api/zero/permission-access-requests (create)
 */
export const permissionAccessRequestsCreateContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/permission-access-requests",
    headers: authHeadersSchema,
    body: createPermissionAccessRequestSchema,
    responses: {
      201: permissionAccessRequestResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Create permission access request",
  },
});

/**
 * Contract for GET /api/zero/permission-access-requests (list)
 */
const permissionAccessRequestsListQuerySchema = z.object({
  agentId: z.string().optional(),
  requestId: z.string().optional(),
  status: z.string().optional(),
});

export const permissionAccessRequestsListContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/permission-access-requests",
    headers: authHeadersSchema,
    query: permissionAccessRequestsListQuerySchema,
    responses: {
      200: z.array(permissionAccessRequestResponseSchema),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List permission access requests for an agent",
  },
});

/**
 * Contract for PUT /api/zero/permission-access-requests (resolve)
 */
export const permissionAccessRequestsResolveContract = c.router({
  resolve: {
    method: "PUT",
    path: "/api/zero/permission-access-requests",
    headers: authHeadersSchema,
    body: resolvePermissionAccessRequestSchema,
    responses: {
      200: permissionAccessRequestResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Resolve (approve/reject) a permission access request (owner only)",
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
export type ZeroAgentPermissionPoliciesRequest = z.infer<
  typeof zeroAgentPermissionPoliciesRequestSchema
>;

export type ZeroAgentsMainContract = typeof zeroAgentsMainContract;
export type ZeroAgentsByIdContract = typeof zeroAgentsByIdContract;
export type ZeroAgentInstructionsContract =
  typeof zeroAgentInstructionsContract;
export type ZeroAgentPermissionPoliciesContract =
  typeof zeroAgentPermissionPoliciesContract;
export type ZeroAgentCustomSkill = z.infer<typeof zeroAgentCustomSkillSchema>;
export type SkillFileEntry = z.infer<typeof skillFileEntrySchema>;
export type SkillFileMetadata = z.infer<typeof skillFileMetadataSchema>;
export type ZeroAgentSkillFilesRequest = z.infer<
  typeof zeroAgentSkillFilesRequestSchema
>;
export type ZeroAgentSkillContentResponse = z.infer<
  typeof zeroAgentSkillContentResponseSchema
>;
export type ZeroSkillsCollectionContract = typeof zeroSkillsCollectionContract;
export type ZeroSkillsDetailContract = typeof zeroSkillsDetailContract;
export type PermissionAccessRequestResponse = z.infer<
  typeof permissionAccessRequestResponseSchema
>;
export type CreatePermissionAccessRequest = z.infer<
  typeof createPermissionAccessRequestSchema
>;
export type ResolvePermissionAccessRequest = z.infer<
  typeof resolvePermissionAccessRequestSchema
>;
export type PermissionAccessRequestsCreateContract =
  typeof permissionAccessRequestsCreateContract;
export type PermissionAccessRequestsListContract =
  typeof permissionAccessRequestsListContract;
export type PermissionAccessRequestsResolveContract =
  typeof permissionAccessRequestsResolveContract;
