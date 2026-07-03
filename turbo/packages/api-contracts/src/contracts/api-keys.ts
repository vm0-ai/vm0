import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const apiKeyItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  tokenPrefix: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  lastUsedAt: z.string().nullable(),
});

export const apiKeyListResponseSchema = z.object({
  apiKeys: z.array(apiKeyItemSchema),
});

export const createApiKeyRequestSchema = z.object({
  name: z.string().min(1).max(100),
  expiresInDays: z.number().int().positive().max(3650),
});

export const createApiKeyResponseSchema = apiKeyItemSchema.extend({
  token: z.string(),
});

export type ApiKeyItem = z.infer<typeof apiKeyItemSchema>;
export type ApiKeyListResponse = z.infer<typeof apiKeyListResponseSchema>;
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;
export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponseSchema>;

export const apiKeysContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/api-keys",
    headers: authHeadersSchema,
    responses: {
      200: apiKeyListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List caller's API keys (metadata only)",
  },
  create: {
    method: "POST",
    path: "/api/zero/api-keys",
    headers: authHeadersSchema,
    body: createApiKeyRequestSchema,
    responses: {
      201: createApiKeyResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create a new API key (token returned once)",
  },
});

export type ApiKeysContract = typeof apiKeysContract;

export const apiKeysByIdContract = c.router({
  delete: {
    method: "DELETE",
    path: "/api/zero/api-keys/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Revoke (delete) an API key",
  },
});

export type ApiKeysByIdContract = typeof apiKeysByIdContract;
