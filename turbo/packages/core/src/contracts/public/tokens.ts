/**
 * Public API v1 - Tokens Contract
 *
 * API token management endpoints for self-service token creation and management.
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
 * Token schema for list responses (no secret shown)
 */
export const publicTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  token_prefix: z.string(), // First 12 chars for identification (e.g., "vm0_api_xxxx")
  last_used_at: timestampSchema.nullable(),
  expires_at: timestampSchema,
  created_at: timestampSchema,
});

export type PublicToken = z.infer<typeof publicTokenSchema>;

/**
 * Token creation response (includes full token - only shown once!)
 */
export const tokenCreatedResponseSchema = publicTokenSchema.extend({
  token: z.string(), // Full token value - ONLY shown on creation
});

export type TokenCreatedResponse = z.infer<typeof tokenCreatedResponseSchema>;

/**
 * Paginated tokens response
 */
export const paginatedTokensSchema =
  createPaginatedResponseSchema(publicTokenSchema);

/**
 * Create token request schema
 */
export const createTokenRequestSchema = z.object({
  name: z
    .string()
    .min(1, "Token name is required")
    .max(100, "Token name must be 100 characters or less"),
  expires_in: z
    .enum(["7d", "30d", "90d", "365d", "never"])
    .default("90d")
    .describe("Token expiration period"),
});

export type CreateTokenRequest = z.infer<typeof createTokenRequestSchema>;

/**
 * Tokens list contract - GET /v1/tokens, POST /v1/tokens
 */
export const publicTokensListContract = c.router({
  list: {
    method: "GET",
    path: "/v1/tokens",
    query: listQuerySchema,
    responses: {
      200: paginatedTokensSchema,
      401: publicApiErrorSchema,
      429: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "List API tokens",
    description:
      "List all API tokens for the current user. Token values are not included.",
  },
  create: {
    method: "POST",
    path: "/v1/tokens",
    body: createTokenRequestSchema,
    responses: {
      201: tokenCreatedResponseSchema,
      400: publicApiErrorSchema,
      401: publicApiErrorSchema,
      429: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Create API token",
    description:
      "Create a new API token. The token value is only returned once - store it securely!",
  },
});

/**
 * Token by ID contract - GET /v1/tokens/:id, DELETE /v1/tokens/:id
 */
export const publicTokenByIdContract = c.router({
  get: {
    method: "GET",
    path: "/v1/tokens/:id",
    pathParams: z.object({
      id: z.string().min(1, "Token ID is required"),
    }),
    responses: {
      200: publicTokenSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      429: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Get API token",
    description:
      "Get API token details by ID. The token value is not included.",
  },
  delete: {
    method: "DELETE",
    path: "/v1/tokens/:id",
    pathParams: z.object({
      id: z.string().min(1, "Token ID is required"),
    }),
    body: z.undefined(),
    responses: {
      204: z.undefined(),
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      429: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Revoke API token",
    description: "Revoke an API token. This action cannot be undone.",
  },
});

export type PublicTokensListContract = typeof publicTokensListContract;
export type PublicTokenByIdContract = typeof publicTokenByIdContract;
