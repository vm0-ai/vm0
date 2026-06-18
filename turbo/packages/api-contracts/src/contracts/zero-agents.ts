import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { persistedAttachmentSchema } from "./chat-threads";

const c = initContract();

export const zeroAgentVisibilitySchema = z.enum(["public", "private"]);
export type ZeroAgentVisibility = z.infer<typeof zeroAgentVisibilitySchema>;

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

export const zeroAgentDraftResponseSchema = z.object({
  draftContent: z.string().nullable(),
  draftAttachments: z.array(persistedAttachmentSchema).nullable(),
});

export const zeroAgentDraftRequestSchema = z.object({
  draftContent: z.string().nullable().optional(),
  draftAttachments: z.array(persistedAttachmentSchema).nullable().optional(),
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

export const zeroAgentDraftContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/agents/:id/draft",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: zeroAgentDraftResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get zero agent draft",
  },
  patch: {
    method: "PATCH",
    path: "/api/zero/agents/:id/draft",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: zeroAgentDraftRequestSchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update zero agent draft",
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
export type ZeroAgentDraftResponse = z.infer<
  typeof zeroAgentDraftResponseSchema
>;
export type ZeroAgentDraftRequest = z.infer<typeof zeroAgentDraftRequestSchema>;

export type ZeroAgentsMainContract = typeof zeroAgentsMainContract;
export type ZeroAgentsByIdContract = typeof zeroAgentsByIdContract;
export type ZeroAgentInstructionsContract =
  typeof zeroAgentInstructionsContract;
export type ZeroAgentDraftContract = typeof zeroAgentDraftContract;
