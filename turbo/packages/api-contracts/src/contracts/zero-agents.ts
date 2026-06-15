import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const zeroAgentVisibilitySchema = z.enum(["public", "private"]);
export type ZeroAgentVisibility = z.infer<typeof zeroAgentVisibilitySchema>;

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
  customSkills: z.array(z.string()).default([]),
  modelProviderId: z.string().uuid().nullable().default(null),
  selectedModel: z.string().nullable().default(null),
  preferPersonalProvider: z.boolean().default(false),
  visibility: zeroAgentVisibilitySchema.optional(),
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
  visibility: zeroAgentVisibilitySchema.optional(),
});

/**
 * Partial metadata update request schema (for PATCH)
 */
export const zeroAgentMetadataRequestSchema = z.object({
  displayName: z.string().optional(),
  description: z.string().optional(),
  sound: z.string().optional(),
  avatarUrl: z.string().nullable().optional(),
  visibility: zeroAgentVisibilitySchema.optional(),
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
      409: apiErrorSchema,
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
      400: apiErrorSchema,
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
      409: apiErrorSchema,
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
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
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
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Delete zero agent by id",
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
      400: apiErrorSchema,
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
      400: apiErrorSchema,
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
 * Skill detail response schema (get with every file's content)
 */
export const zeroAgentSkillDetailResponseSchema =
  zeroAgentSkillContentResponseSchema.extend({
    fileContents: z.array(skillFileEntrySchema).nullable(),
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
      200: zeroAgentSkillDetailResponseSchema,
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
      400: apiErrorSchema,
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

export type ZeroAgentsMainContract = typeof zeroAgentsMainContract;
export type ZeroAgentsByIdContract = typeof zeroAgentsByIdContract;
export type ZeroAgentInstructionsContract =
  typeof zeroAgentInstructionsContract;
export type ZeroAgentCustomSkill = z.infer<typeof zeroAgentCustomSkillSchema>;
export type SkillFileEntry = z.infer<typeof skillFileEntrySchema>;
export type SkillFileMetadata = z.infer<typeof skillFileMetadataSchema>;
export type ZeroAgentSkillFilesRequest = z.infer<
  typeof zeroAgentSkillFilesRequestSchema
>;
export type ZeroAgentSkillContentResponse = z.infer<
  typeof zeroAgentSkillContentResponseSchema
>;
export type ZeroAgentSkillDetailResponse = z.infer<
  typeof zeroAgentSkillDetailResponseSchema
>;
export type ZeroSkillsCollectionContract = typeof zeroSkillsCollectionContract;
export type ZeroSkillsDetailContract = typeof zeroSkillsDetailContract;
