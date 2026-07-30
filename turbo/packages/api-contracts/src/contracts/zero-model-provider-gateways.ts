import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import type { ModelProviderType } from "./model-provider-types";

const c = initContract();

export const modelProviderSurfaceProtocolSchema = z.enum([
  "anthropic-messages",
  "openai-responses",
]);

export type ModelProviderSurfaceProtocol = z.infer<
  typeof modelProviderSurfaceProtocolSchema
>;

/**
 * Custom gateways reuse the existing Claude Code and Codex runtime adapters.
 * The provider type is an internal adapter identity, not the gateway brand.
 */
export function getModelProviderTypeForSurfaceProtocol(
  protocol: ModelProviderSurfaceProtocol,
): ModelProviderType {
  return protocol === "anthropic-messages"
    ? "vercel-ai-gateway"
    : "vercel-ai-gateway-codex";
}

export const modelProviderSurfaceInputSchema = z.object({
  protocol: modelProviderSurfaceProtocolSchema,
  apiBaseUrl: z.string().min(1),
  authHeaderName: z.string().min(1),
  authHeaderTemplate: z.string().min(1),
  modelMappings: z.record(z.string(), z.string()),
});

export const modelProviderSurfaceResponseSchema =
  modelProviderSurfaceInputSchema.extend({
    id: z.uuid(),
    createdAt: z.string(),
    updatedAt: z.string(),
  });

export const modelProviderConnectionResponseSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  surfaces: z.array(modelProviderSurfaceResponseSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ModelProviderConnectionResponse = z.infer<
  typeof modelProviderConnectionResponseSchema
>;

export const modelProviderConnectionsResponseSchema = z.object({
  connections: z.array(modelProviderConnectionResponseSchema),
});

export const createModelProviderConnectionRequestSchema = z.object({
  displayName: z.string().min(1),
  secret: z.string().min(1),
  surfaces: z.array(modelProviderSurfaceInputSchema).min(1).max(2),
});

export const updateModelProviderConnectionRequestSchema = z.object({
  displayName: z.string().min(1),
  secret: z.string().min(1).optional(),
  surfaces: z.array(modelProviderSurfaceInputSchema).min(1).max(2),
});

export type CreateModelProviderConnectionRequest = z.infer<
  typeof createModelProviderConnectionRequestSchema
>;
export type UpdateModelProviderConnectionRequest = z.infer<
  typeof updateModelProviderConnectionRequestSchema
>;

export const zeroModelProviderConnectionsMainContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/model-provider-connections",
    headers: authHeadersSchema,
    responses: {
      200: modelProviderConnectionsResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List custom model provider connections",
  },
  create: {
    method: "POST",
    path: "/api/zero/model-provider-connections",
    headers: authHeadersSchema,
    body: createModelProviderConnectionRequestSchema,
    responses: {
      201: modelProviderConnectionResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create a custom model provider connection",
  },
});

export const zeroModelProviderConnectionsByIdContract = c.router({
  update: {
    method: "PUT",
    path: "/api/zero/model-provider-connections/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    body: updateModelProviderConnectionRequestSchema,
    responses: {
      200: modelProviderConnectionResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update a custom model provider connection",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/model-provider-connections/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete a custom model provider connection",
  },
});
